// Finite A07 foundation proof over actual emitted values hosts and the
// owning Cloudflare local-run producer. Supply private staged emit paths;
// this never writes shared dist/target or changes backend defaults.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dist = resolve(process.env.CAN_VALUES_DIST ?? "packages/values/dist");
const self = fileURLToPath(import.meta.url);
const wasmPath = join(dist, "bindings/generated/values_semantics_bg.wasm");
const bytes = () => new Uint8Array(readFileSync(wasmPath));
const bootstrapURL = pathToFileURL(join(dist, "bindings/bootstrap.js")).href;
const hostCase = process.argv.find((arg) => arg.startsWith("--host-case="))?.split("=")[1];

// Deliberate independent startup-control module, not generated production
// glue: exports abi_version=999 and the no-op wasm-bindgen start hook.
const utf8 = (value) => [...new TextEncoder().encode(value)];
const section = (id, payload) => [id, payload.length, ...payload];
const wrongABI = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  ...section(1, [2, 96, 0, 1, 127, 96, 0, 0]),
  ...section(3, [2, 0, 1]),
  ...section(7, [2, 11, ...utf8("abi_version"), 0, 0, 16, ...utf8("__wbindgen_start"), 0, 1]),
  ...section(10, [2, 5, 0, 65, 231, 7, 11, 2, 0, 11]),
]);
const emptyModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const missingTransport = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0,
  ...section(1, [2, 96, 0, 1, 127, 96, 0, 0]),
  ...section(3, [2, 0, 1]),
  ...section(7, [2, 11, ...utf8("abi_version"), 0, 0, 16, ...utf8("__wbindgen_start"), 0, 1]),
  ...section(10, [2, 4, 0, 65, 1, 11, 2, 0, 11]),
]);

if (hostCase !== undefined) {
  const { bootstrapWasm, BootstrapError } = await import(bootstrapURL);
  const expectCode = (action, code) => assert.throws(action, (error) => {
    assert.ok(error instanceof BootstrapError);
    assert.equal(error.code, code);
    return true;
  });
  if (hostCase === "compiled") {
    const module = new WebAssembly.Module(bytes());
    const first = bootstrapWasm(module);
    assert.equal(first.call("add-int", [1n, 2n]), 3n);
    assert.equal(bootstrapWasm(module).call("add-int", [2n, 3n]), 5n);
    expectCode(() => bootstrapWasm(new WebAssembly.Module(bytes())), "init-failed");
    expectCode(() => bootstrapWasm(bytes()), "init-failed");
    assert.equal(first.call("add-int", [3n, 4n]), 7n);
  } else if (hostCase === "abi") {
    expectCode(() => bootstrapWasm(new WebAssembly.Module(wrongABI)), "abi-mismatch");
  } else if (hostCase === "missing-exports") {
    expectCode(() => bootstrapWasm(new WebAssembly.Module(emptyModule)), "init-failed");
  } else if (hostCase === "missing-transport-exports") {
    expectCode(() => bootstrapWasm(new WebAssembly.Module(missingTransport)), "init-failed");
  } else if (hostCase === "caller-methods") {
    bootstrapWasm(bytes());
    const corrupt = bytes();
    corrupt[0] = 255;
    corrupt.every = () => true;
    corrupt[Symbol.iterator] = () => { throw new Error("caller iterator must not execute"); };
    expectCode(() => bootstrapWasm(corrupt), "init-failed");
    assert.equal(bootstrapWasm(bytes()).call("add-int", [2n, 3n]), 5n);
  } else if (hostCase === "first-asset-mutation") {
    const first = bytes();
    const backend = bootstrapWasm(first);
    first[0] = 255;
    expectCode(() => bootstrapWasm(first), "init-failed");
    assert.equal(bootstrapWasm(bytes()).call("add-int", [2n, 3n]), 5n);
    assert.equal(backend.call("add-int", [3n, 4n]), 7n);
  } else if (hostCase === "caller-methods-first") {
    const first = bytes();
    first[Symbol.iterator] = () => { throw new Error("caller iterator must not execute"); };
    Object.defineProperty(first, "length", { value: 0 });
    assert.equal(bootstrapWasm(first).call("add-int", [2n, 3n]), 5n);
  } else if (hostCase === "externally-initialized") {
    const { initSync } = await import(pathToFileURL(join(dist, "bindings/generated/values_semantics.js")).href);
    initSync({ module: bytes() });
    expectCode(() => bootstrapWasm(new WebAssembly.Module(wrongABI)), "init-failed");
  } else {
    throw new Error(`unknown host case: ${hostCase}`);
  }
  console.log(JSON.stringify({ hostCase, status: "passed", executable: process.execPath }));
} else {
  for (const test of ["compiled", "abi", "missing-exports", "missing-transport-exports", "caller-methods", "first-asset-mutation", "caller-methods-first", "externally-initialized"]) {
    process.stdout.write(execFileSync(process.execPath, [self, `--host-case=${test}`], {
      encoding: "utf8", env: process.env,
    }));
  }
  if (!process.argv.includes("--host-only")) {
    const localRun = resolve(process.env.CAN_LOCAL_RUN ?? "packages/cloudflare/dist/dev/local-run.js");
    const { startLocalDev } = await import(pathToFileURL(localRun).href);
    const modules = {};
    const collect = (relative) => {
      const key = `values/${relative}`;
      if (modules[key] !== undefined) return;
      const source = readFileSync(join(dist, relative), "utf8");
      modules[key] = source;
      for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+\.js)["']/g)) {
        collect(join(dirname(relative), match[1]));
      }
    };
    collect("bindings/bootstrap.js");
    const positive = `
      import module from './values/bindings/generated/values_semantics_bg.wasm';
      import { bootstrapWasm } from './values/bindings/bootstrap.js';
      import { Decimal } from './values/src/decimal.js';
      import { makeDate, makeMoney } from './values/src/kinds.js';
      const backend = bootstrapWasm(module);
      const again = bootstrapWasm(module);
      export default { fetch() {
        const decimal = backend.call('add-decimal', [new Decimal(15n, 1), 2n]);
        const money = backend.call('add-money', [makeMoney(100n, 'USD'), makeMoney(25n, 'USD')]);
        let rejected;
        try { bootstrapWasm(new Uint8Array([0,1,2,3])); } catch (error) { rejected = error.code; }
        return Response.json({ int: String(again.call('add-int', [2n, 3n])),
          date: backend.call('date-to-epoch-days', [makeDate(2024, 2, 29)]),
          decimal: { instance: decimal instanceof Decimal, frozen: Object.isFrozen(decimal),
            coef: String(decimal.coef), bigint: typeof decimal.coef, scale: decimal.scale },
          money: { frozen: Object.isFrozen(money), minor: String(money.minor), bigint: typeof money.minor },
          changedAsset: rejected });
      } };`;
    const binaryKey = "values/bindings/generated/values_semantics_bg.wasm";
    const run = async (entry, binaryModules, check) => {
      let local;
      try {
        local = await startLocalDev({ workerName: "values-bootstrap-foundation", compatibilityDate: "2026-07-30",
          mainModule: "worker.mjs", modules: { ...modules, "worker.mjs": entry }, binaryModules });
        await check(await local.dispatch("/"));
      } finally {
        await local?.dispose();
      }
    };
    const expected = { int: "5", date: 19782,
      decimal: { instance: true, frozen: true, coef: "35", bigint: "bigint", scale: 1 },
      money: { frozen: true, minor: "125", bigint: "bigint" }, changedAsset: "init-failed" };
    for (let isolate = 0; isolate < 2; isolate += 1) {
      await run(positive, { [binaryKey]: bytes() }, async (response) => {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), expected);
      });
    }
    const negative = `import module from './${binaryKey}';
      import { bootstrapWasm } from './values/bindings/bootstrap.js';
      let code; try { bootstrapWasm(module); } catch (error) { code = error.code; }
      export default { fetch() { return Response.json({ code }); } };`;
    for (const [asset, code] of [[wrongABI, "abi-mismatch"], [emptyModule, "init-failed"], [missingTransport, "init-failed"]]) {
      await run(negative, { [binaryKey]: asset }, async (response) => {
        assert.deepEqual(await response.json(), { code });
      });
    }
    for (const [assets, name] of [[{}, "missing"], [{ [binaryKey]: new Uint8Array([0, 1, 2, 3]) }, "corrupt"]]) {
      await assert.rejects(run(positive, assets, async () => {}));
      console.log(JSON.stringify({ workerdStartup: name, status: "rejected" }));
    }
    console.log(JSON.stringify({ workerd: "passed", freshIsolates: 2, localRun, moduleCount: Object.keys(modules).length + 2 }));
  }
}
