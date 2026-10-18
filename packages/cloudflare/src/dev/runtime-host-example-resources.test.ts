import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeExampleResources } from "./runtime-host-example-resources.js";
import { parseExampleRecipe, serializeExampleRecipe } from "./runtime-host-examples.js";

test("failed example or qualification cleanup retains the same handle for a joined retry", async () => {
  const resources = new RuntimeExampleResources(), key = {};
  let attempts = 0;
  let release!: () => void;
  resources.retain(key, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("runtime still owned");
    await new Promise<void>(resolve => { release = resolve; });
  });
  await assert.rejects(resources.dispose(key), /runtime still owned/);
  const direct = resources.dispose(key), joined = resources.drain();
  await Promise.resolve();
  assert.equal(attempts, 2, "concurrent release shares the original resource handle");
  let settled = false;
  void joined.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  release(); await Promise.all([direct, joined]);
  await resources.drain(); assert.equal(attempts, 2, "released handles no longer consume retention");
});

test("retained example recipe preserves exact artifact and binary bytes without serving state", () => {
  const artifactBytes = Buffer.from(`{"payload":"${"large artifact ".repeat(1000)}"}`);
  const input = { artifactBytes, artifactLabel: "Captured.can", sourceRevision: `sha256:${"a".repeat(64)}`,
    workerName: "captured", compatibilityDate: "2026-07-15", d1Binding: "DB",
    worker: { mainModule: "main.js", modules: { "main.js": "export default {}" }, binaryModules: { "value.wasm": new Uint8Array([0, 255, 128]) } } };
  const wire = JSON.stringify(serializeExampleRecipe(input));
  const parsed = parseExampleRecipe(JSON.parse(wire));
  artifactBytes.fill(0);
  assert.notEqual(Buffer.from(parsed.artifactBytes).readUInt8(0), 0);
  assert.deepEqual([...parsed.worker.binaryModules!["value.wasm"]!], [0, 255, 128]);
  assert.equal(parsed.worker.modules["main.js"], "export default {}");
  assert.equal("actors" in parsed, false);
  assert.throws(() => parseExampleRecipe({ ...JSON.parse(wire), artifactBytes: "%%%" }), /recipe bytes/);
});

test("cancellation joins an allocation already in flight before declaring resources released", async () => {
  const resources = new RuntimeExampleResources();
  let finish!: () => void;
  let disposed = false;
  const allocated = resources.allocate(async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    const key = {};
    resources.retain(key, async () => { disposed = true; });
    return key;
  });
  await Promise.resolve();
  let joined = false;
  const drain = resources.drain().then(() => { joined = true; });
  await Promise.resolve(); assert.equal(joined, false);
  finish(); await allocated; await drain;
  assert.equal(disposed, true);
});

test("cleanup failure preserves the primary operation error and its retryable release", async () => {
  const resources = new RuntimeExampleResources(), key = {};
  const primary = new Error("row invocation failed");
  let attempts = 0;
  resources.retain(key, async () => { if (++attempts === 1) throw new Error("D1 release failed"); });
  let failure: unknown;
  try { await resources.using(key, async () => { throw primary; }); }
  catch (error) { failure = error; }
  const { DevCleanupError } = await import("./cleanup.js");
  assert.ok(failure instanceof DevCleanupError);
  assert.equal(failure.cause, primary);
  await failure.dispose();
  await resources.drain();
  assert.equal(attempts, 2);
});
