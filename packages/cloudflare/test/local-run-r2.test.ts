import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startLocalDev, type LocalDev, type LocalDevOptions } from "../src/runtime/native-preview.test-support.js";

const worker = `export default { async fetch(request, env) {
  const url = new URL(request.url), key = url.searchParams.get("key") ?? "object";
  const bucket = env[url.searchParams.get("bucket") ?? "FILES"];
  if (request.method === "PUT") {
    const object = await bucket.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: "text/plain" }, customMetadata: { owner: "local" } });
    return Response.json({ key: object.key, size: object.size });
  }
  if (request.method === "DELETE") { await bucket.delete(key); return new Response(null, { status: 204 }); }
  if (url.pathname === "/list") return Response.json((await bucket.list({ prefix: url.searchParams.get("prefix") ?? "" })).objects.map(object => object.key));
  const object = await bucket.get(key);
  if (object === null) return new Response(null, { status: 404 });
  const headers = new Headers(); object.writeHttpMetadata(headers);
  headers.set("x-object-owner", object.customMetadata.owner);
  headers.set("x-dispatch-header", String(request.headers.get("x-can-local-dispatch")));
  return new Response(object.body, { headers });
} };`;
const options = (extra: Partial<LocalDevOptions> = {}): LocalDevOptions => ({
  workerName: "local-r2", compatibilityDate: "2026-07-15", mainModule: "main.js", modules: { "main.js": worker },
  r2Buckets: [{ binding: "FILES", id: "files" }, { binding: "OTHER", id: "other" }], ...extra,
});

describe("local R2 bindings", () => {
  it("round-trips put/get/list/delete through the real Worker and host binding", async () => {
    const dev = await startLocalDev(options());
    try {
      expect((await dev.dispatch("/?key=notes/one", { method: "PUT", body: "local bytes" })).status).toBe(200);
      const response = await dev.dispatch("/?key=notes/one");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(response.headers.get("x-object-owner")).toBe("local");
      expect(response.headers.get("x-dispatch-header")).toBe("null");
      expect(await response.text()).toBe("local bytes");
      expect(await (await dev.dispatch("/list?prefix=notes/")).json()).toEqual(["notes/one"]);
      expect(await (await dev.dispatch("/list?prefix=absent/")).json()).toEqual([]);
      const bucket = await dev.getR2Bucket("FILES");
      expect(await (await bucket.get("notes/one"))!.text()).toBe("local bytes");
      expect(await (await dev.getR2Bucket("OTHER")).list()).toMatchObject({ objects: [] });
      expect((await dev.dispatch("/?key=notes/one", { method: "DELETE" })).status).toBe(204);
      expect(await bucket.get("notes/one")).toBeNull();
      expect((await dev.dispatch("/?key=notes/one")).status).toBe(404);
    } finally { await dev.dispose(); }
  }, 30_000);

  it("preserves bodies and metadata across restarts while isolating bucket and storage namespaces", async () => {
    const root = mkdtempSync(join(tmpdir(), "can-local-r2-"));
    let dev: LocalDev | undefined;
    try {
      const r2Persist = join(root, "first");
      dev = await startLocalDev(options({ r2Persist }));
      await dev.dispatch("/?key=same", { method: "PUT", body: "retained" });
      await (await dev.getR2Bucket("OTHER")).put("same", "other bucket");
      await dev.dispose(); dev = undefined;
      dev = await startLocalDev(options({ r2Persist }));
      const retained = await (await dev.getR2Bucket("FILES")).get("same");
      expect(await retained!.text()).toBe("retained");
      expect(retained!.httpMetadata).toMatchObject({ contentType: "text/plain" });
      expect(retained!.customMetadata).toEqual({ owner: "local" });
      expect(await (await (await dev.getR2Bucket("OTHER")).get("same"))!.text()).toBe("other bucket");
      await dev.dispose(); dev = undefined;
      dev = await startLocalDev(options({ r2Persist: join(root, "second") }));
      expect(await (await dev.getR2Bucket("FILES")).get("same")).toBeNull();
    } finally { await dev?.dispose(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it("isolates default temporary buckets between local instances", async () => {
    const first = await startLocalDev(options());
    let second: LocalDev | undefined;
    try {
      await (await first.getR2Bucket("FILES")).put("private", "first instance");
      second = await startLocalDev(options());
      expect(await (await second.getR2Bucket("FILES")).get("private")).toBeNull();
      expect(await (await (await first.getR2Bucket("FILES")).get("private"))!.text()).toBe("first instance");
    } finally { await second?.dispose(); await first.dispose(); }
  }, 30_000);
});
