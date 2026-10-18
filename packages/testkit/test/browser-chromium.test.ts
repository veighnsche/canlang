import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type * as ChromiumLeaf from "../src/browser/chromium.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Copy the genuine emitted public leaf and owning manifest into an application.
 * Driver doubles below cover refusal/lifecycle only; they never qualify Chromium.
 */
async function application(mode = "driver") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "testkit-chromium-"))); roots.push(root);
  const installed = join(root, "node_modules/@canlang/testkit");
  await mkdir(join(installed, "dist/browser"), { recursive: true });
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  await copyFile(join(packageRoot, "package.json"), join(installed, "package.json"));
  await copyFile(join(packageRoot, "dist/browser/chromium.js"), join(installed, "dist/browser/chromium.js"));
  const cloudflare = join(root, "node_modules/@canlang/cloudflare");
  await mkdir(join(cloudflare, "dist/runtime"), { recursive: true });
  await writeFile(join(cloudflare, "package.json"), JSON.stringify({ name: "@canlang/cloudflare", type: "module", exports: { "./runtime/browser-tools": "./dist/runtime/browser-tools.js" } }));
  await copyFile(join(packageRoot, "../cloudflare/dist/runtime/browser-tools.js"), join(cloudflare, "dist/runtime/browser-tools.js"));

  const executable = join(root, "chromium");
  if (mode === "directory") await mkdir(executable);
  else if (mode !== "missing-executable") { await writeFile(executable, "driver-double executable\n"); await chmod(executable, mode === "permissions" ? 0o644 : 0o755); }
  const driverRoot = join(root, "node_modules/@playwright/test");
  if (mode !== "missing-driver") {
    await mkdir(driverRoot, { recursive: true });
    await writeFile(join(driverRoot, "package.json"), JSON.stringify({ name: "@playwright/test", type: mode === "cjs" ? "commonjs" : "module",
      exports: mode === "exports" ? {} : mode === "entry" ? "./missing.js" : "./index.js" }));
    const source = mode === "import" ? 'throw new Error("broken installed import");'
      : mode === "api" ? 'export const chromium = {};'
      : `export const control = { launches: [], closeCalls: 0, launch: null, close: null };
         export const browser = { close() { control.closeCalls++; return control.close ? control.close() : Promise.resolve(); } };
         export const chromium = {
           executablePath() { return ${JSON.stringify(mode === "path" ? "" : executable)}; },
           launch(options) { control.launches.push(options); return control.launch ? control.launch() : Promise.resolve(browser); }
         };`;
    await writeFile(join(driverRoot, "index.js"), mode === "cjs"
      ? source.replaceAll("export const ", "const ") + "\nmodule.exports = Object.assign({}, { control, browser, chromium });\n"
      : source);
  }
  const require = createRequire(join(root, "application.mjs"));
  const entry = require.resolve("@canlang/testkit/browser/chromium");
  expect(entry).toBe(join(installed, "dist/browser/chromium.js"));
  expect(await readFile(entry, "utf8")).toBe(await readFile(join(packageRoot, "dist/browser/chromium.js"), "utf8"));
  const leaf = await import(pathToFileURL(entry).href) as typeof ChromiumLeaf;
  return { root, executable, driverRoot, leaf, require };
}

type DriverDouble = {
  browser: { close(): Promise<void> };
  control: { launches: unknown[]; closeCalls: number; launch: (() => Promise<unknown>) | null; close: (() => Promise<void>) | null };
};
async function driver(app: Awaited<ReturnType<typeof application>>): Promise<DriverDouble> {
  return import(pathToFileURL(app.require.resolve("@playwright/test")).href) as Promise<DriverDouble>;
}

describe("installed optional Chromium leaf", () => {
  it("distinguishes a genuinely absent driver/executable from a broken installed producer", async () => {
    const missing = await application("missing-driver");
    expect(await missing.leaf.chromiumAvailability()).toEqual({ available: false, reason: "driver-not-installed" });
    await expect(missing.leaf.acquireChromium()).rejects.toBeInstanceOf(missing.leaf.MissingChromiumProducerError);
    const noExecutable = await application("missing-executable");
    expect(await noExecutable.leaf.chromiumAvailability()).toEqual({ available: false, reason: "executable-not-installed",
      identity: { driverEntryPath: join(noExecutable.driverRoot, "index.js"), executablePath: noExecutable.executable } });
    for (const mode of ["exports", "entry", "import", "api", "path", "directory", "permissions"]) {
      const broken = await application(mode);
      await expect(broken.leaf.chromiumAvailability()).rejects.not.toBeInstanceOf(broken.leaf.MissingChromiumProducerError);
      await expect(broken.leaf.acquireChromium()).rejects.not.toBeInstanceOf(broken.leaf.MissingChromiumProducerError);
    }
  });

  it("returns the driver browser and exact identity with one shared awaited close", async () => {
    // The locked genuine entry dynamically assembles CommonJS exports.
    const app = await application("cjs"); const installed = app.require("@playwright/test") as DriverDouble;
    expect(await app.leaf.chromiumAvailability()).toEqual({ available: true,
      identity: { driverEntryPath: join(app.driverRoot, "index.js"), executablePath: app.executable } });
    const closing = deferred<void>(); installed.control.close = () => closing.promise;
    const owned = await app.leaf.acquireChromium({ timeoutMs: 1234 });
    expect(Object.keys(owned).sort()).toEqual(["browser", "close", "identity"]);
    expect(owned.browser).toBe(installed.browser);
    expect(Object.isFrozen(owned.identity)).toBe(true);
    expect(owned.identity.executablePath).toBe(app.executable);
    expect(installed.control.launches).toEqual([{ headless: true, executablePath: app.executable, timeout: 1234 }]);
    const first = owned.close(); expect(owned.close()).toBe(first);
    let settled = false; void first.then(() => { settled = true; });
    await Promise.resolve(); expect(installed.control.closeCalls).toBe(1); expect(settled).toBe(false);
    closing.resolve(); await first; expect(settled).toBe(true);
    expect(owned.close()).toBe(first); expect(installed.control.closeCalls).toBe(1);
  });

  it("does not launch for pre-abort or invalid launch bounds", async () => {
    const app = await application(); const installed = await driver(app);
    const aborted = new AbortController(); const reason = new Error("pre-abort"); aborted.abort(reason);
    await expect(app.leaf.acquireChromium({ signal: aborted.signal })).rejects.toBe(reason);
    for (const timeoutMs of [0, -1, Infinity, NaN]) await expect(app.leaf.acquireChromium({ timeoutMs })).rejects.toThrow(/positive and finite/);
    expect(installed.control.launches).toEqual([]);
  });

  it("waits for a late launch and its browser cleanup before rejecting cancellation", async () => {
    const app = await application(); const installed = await driver(app);
    const launched = deferred<unknown>(), started = deferred<void>(), closed = deferred<void>(), closeStarted = deferred<void>();
    installed.control.launch = () => { started.resolve(); return launched.promise; };
    installed.control.close = () => { closeStarted.resolve(); return closed.promise; };
    const controller = new AbortController(); const reason = new Error("late abort");
    const acquisition = app.leaf.acquireChromium({ signal: controller.signal });
    let settled = false; void acquisition.then(() => { settled = true; }, () => { settled = true; });
    await started.promise; controller.abort(reason); expect(settled).toBe(false);
    launched.resolve(installed.browser); await closeStarted.promise;
    expect(installed.control.closeCalls).toBe(1); expect(settled).toBe(false);
    closed.resolve(); await expect(acquisition).rejects.toBe(reason);
  });

  it("owns cancellation after acquisition and retains cleanup rejection for the caller", async () => {
    for (const fails of [false, true]) {
      const app = await application(); const installed = await driver(app);
      const closed = deferred<void>(); installed.control.close = () => closed.promise;
      const controller = new AbortController(); const owned = await app.leaf.acquireChromium({ signal: controller.signal });
      controller.abort(new Error("after acquisition"));
      const cleanup = owned.close(); expect(owned.close()).toBe(cleanup);
      await Promise.resolve(); expect(installed.control.closeCalls).toBe(1);
      if (fails) {
        const failure = new Error("cleanup rejected"); closed.reject(failure);
        await expect(cleanup).rejects.toBe(failure); await expect(owned.close()).rejects.toBe(failure);
      } else { closed.resolve(); await cleanup; }
      expect(installed.control.closeCalls).toBe(1);
    }
  });
});
