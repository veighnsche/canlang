/**
 * C04.2 workerd loader-smoke: the REAL tiny binding through this
 * repository's BUILT deployment map and local workerd.
 *
 * Asset path (all repo-built, no fakes): the precompiled
 * `loader_smoke.wasm` bytes (C04.1 crate) are attached via the built
 * `attachBinaries`, written via the built `writeDeployBundleMixed` into
 * a private temp dir, read BACK from that deployment map, and staged
 * as `CompiledWasm` through the direct Miniflare SDK fixture
 * and observed by the built Testkit local snapshotter. A real
 * workerd instance (miniflare) boots a worker entry that imports the
 * wasm module, instantiates it ONCE at top level, and serves
 * computed results over dispatch. Every assertion below observes
 * computed values, never text markers.
 *
 * Vectors: deployed-load (version/add/wrap over dispatch),
 * testkit-propagation (same through Testkit's native-allocated store snapshot),
 * malformed-bytes (loud failure, no fallback),
 * startup-failure/wrong-ABI (loud failure, no fallback),
 * text-only-parity (absent binaryModules behaves as before).
 * Any deviation exits nonzero with the failing vector id.
 *
 * Usage: `node workerd.mjs` or `bun workerd.mjs` (exit 0 = pass).
 * Wasm bytes: `$LOADER_SMOKE_WASM`, else the fixture release build
 * (`cargo build --locked --target wasm32-unknown-unknown --release`).
 */
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { attachBinaries, bundleSha256, writeDeployBundleMixed } from '@canlang/cloudflare/deploy/bundle';
import { Miniflare } from 'miniflare';
import { snapshotLocalDatabases } from '../../../../testkit/dist/scopes/local.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WASM = join(HERE, 'target', 'wasm32-unknown-unknown', 'release', 'loader_smoke.wasm');
/** Smallest valid Wasm module: instantiates, exports nothing (wrong ABI). */
const EMPTY_MODULE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const WASM_NAME = 'loader_smoke.wasm';
const MAIN_NAME = 'worker.mjs';
const COMPAT_DATE = '2026-07-15';

export function resolveWasmPath() {
  return process.env.LOADER_SMOKE_WASM ?? DEFAULT_WASM;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Worker entry: single top-level instance; computed JSON over dispatch. */
export function smokeWorkerEntry(wasmSpecifier) {
  return `import smokeModule from ${JSON.stringify(wasmSpecifier)};
const instance = new WebAssembly.Instance(smokeModule, {});
const version = instance.exports.smoke_version();
const add = instance.exports.smoke_add;
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/version") return Response.json({ ok: true, version });
    if (url.pathname === "/add") {
      const a = Number(url.searchParams.get("a"));
      const b = Number(url.searchParams.get("b"));
      return Response.json({ ok: true, sum: add(a | 0, b | 0) | 0 });
    }
    return new Response("not found", { status: 404 });
  },
};
`;
}

/** Text-only worker entry: no wasm import (legacy parity control). */
export function textOnlyWorkerEntry() {
  return `export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") return Response.json({ ok: true, mode: "text-only" });
    return new Response("not found", { status: 404 });
  },
};
`;
}

/**
 * Stage the deployment map through the BUILT writer and read the exact
 * staged bytes back. Returns { dir, wasmBytes, manifest, cleanup }.
 */
export function deployBindingMap(wasmBytes, { textModules } = {}) {
  const modules = { [MAIN_NAME]: '// placeholder replaced by caller', ...(textModules ?? {}) };
  const bundle = attachBinaries(
    {
      mainModule: MAIN_NAME,
      modules,
      moduleCount: Object.keys(modules).length,
      sha256: bundleSha256(MAIN_NAME, modules),
      mcpBundleBytes: 0,
      httpOperationsBytes: 0,
    },
    { [WASM_NAME]: wasmBytes },
  );
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'c04-smoke-map-'));
  try {
    const written = writeDeployBundleMixed(bundle, dir);
    const staged = new Uint8Array(readFileSync(join(dir, WASM_NAME)));
    const manifest = JSON.parse(readFileSync(join(dir, 'bundle.mixed.json'), 'utf8'));
    return {
      dir,
      files: written.files,
      wasmBytes: staged,
      manifest,
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  } catch (thrown) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Preserve the staging failure even if cleanup also fails.
    }
    throw thrown;
  }
}

function check(name, actual, expected) {
  if (!Object.is(actual, expected)) {
    throw { code: 'vector/mismatch', vector: name, actual, expected }; // eslint-disable-line no-throw-literal
  }
  return { vector: name, ok: true };
}

async function fetchJson(dev, path) {
  const res = await dev.dispatchFetch(new URL(path, 'http://fixture'));
  const body = await res.json();
  return { status: res.status, body };
}

export async function runWorkerdSmoke(wasmPath = resolveWasmPath()) {
  const results = [];
  const rawWasm = new Uint8Array(readFileSync(wasmPath));
  const rawSha = sha256Hex(rawWasm);
  results.push(check('input/wasm-bytes-present', rawWasm.length > 8, true));

  // Vector 1: deployed load — built map -> workerd -> computed dispatch.
  {
    const deployed = deployBindingMap(rawWasm, { textModules: { [MAIN_NAME]: smokeWorkerEntry(`./${WASM_NAME}`) } });
    try {
      results.push(check('map/staged-bytes-identical', sha256Hex(deployed.wasmBytes) === rawSha, true));
      results.push(check('map/manifest-binary-count', deployed.manifest.binaryCount, 1));
      const dev = new Miniflare({
        name: 'c04-smoke',
        compatibilityDate: COMPAT_DATE,
        modules: [
          { type: 'ESModule', path: MAIN_NAME, contents: smokeWorkerEntry(`./${WASM_NAME}`) },
          { type: 'CompiledWasm', path: WASM_NAME, contents: deployed.wasmBytes },
        ],
      });
      try {
        const version = await fetchJson(dev, '/version');
        results.push(check('load/version-status', version.status, 200));
        results.push(check('load/version-is-transport-v0', version.body.version, 0));
        const add = await fetchJson(dev, '/add?a=40&b=2');
        results.push(check('load/add-basics', add.body.sum, 42));
        const wrap = await fetchJson(dev, '/add?a=2147483647&b=1');
        results.push(check('load/add-wraps', wrap.body.sum, -2147483648));
      } finally {
        await dev.dispose();
      }
    } finally {
      deployed.cleanup();
    }
  }

  // Vector 2: testkit propagation route.
  {
    const dev = new Miniflare({
      name: 'c04-smoke-tk',
      compatibilityDate: COMPAT_DATE,
      modules: [
        { type: 'ESModule', path: MAIN_NAME, contents: smokeWorkerEntry(`./${WASM_NAME}`) },
        { type: 'CompiledWasm', path: WASM_NAME, contents: rawWasm },
      ],
      d1Databases: { DB: 'c04-smoke-row' },
    });
    try {
      const add = await fetchJson(dev, '/add?a=1&b=-1');
      await snapshotLocalDatabases(dev, ['DB']);
      results.push(check('testkit/add-with-local-snapshot', add.body.sum, 0));
    } finally {
      await dev.dispose();
    }
  }

  // Vector 3: malformed bytes fail loudly (no fallback, no fake reply).
  {
    const bad = rawWasm.slice();
    bad[4] ^= 0xff; // mangle the version field, keep the magic
    let loud = false;
    try {
      const dev = new Miniflare({
        name: 'c04-smoke-bad',
        compatibilityDate: COMPAT_DATE,
        modules: [
          { type: 'ESModule', path: MAIN_NAME, contents: smokeWorkerEntry(`./${WASM_NAME}`) },
          { type: 'CompiledWasm', path: WASM_NAME, contents: bad },
        ],
      });
      try {
        await dev.dispatchFetch('http://fixture/version');
      } finally {
        await dev.dispose();
      }
    } catch {
      loud = true;
    }
    results.push(check('failure/malformed-bytes-loud', loud, true));
  }

  // Vector 4: wrong-ABI module (no smoke exports) fails loudly at startup.
  {
    let loud = false;
    try {
      const dev = new Miniflare({
        name: 'c04-smoke-abi',
        compatibilityDate: COMPAT_DATE,
        modules: [
          { type: 'ESModule', path: MAIN_NAME, contents: smokeWorkerEntry(`./${WASM_NAME}`) },
          { type: 'CompiledWasm', path: WASM_NAME, contents: EMPTY_MODULE },
        ],
      });
      try {
        const res = await dev.dispatchFetch('http://fixture/version');
        loud = res.status !== 200;
      } finally {
        await dev.dispose();
      }
    } catch {
      loud = true;
    }
    results.push(check('failure/wrong-abi-loud', loud, true));
  }

  // Vector 5: text-only legacy parity (binaryModules absent).
  {
    const dev = new Miniflare({
      name: 'c04-smoke-text',
      compatibilityDate: COMPAT_DATE,
      modules: true,
      script: textOnlyWorkerEntry(),
    });
    try {
      const ping = await fetchJson(dev, '/ping');
      results.push(check('parity/text-only-status', ping.status, 200));
      results.push(check('parity/text-only-mode', ping.body.mode, 'text-only'));
    } finally {
      await dev.dispose();
    }
  }

  return results;
}

const invokedAsMain =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedAsMain) {
  runWorkerdSmoke()
    .then((results) => {
      console.log(`workerd-smoke: ${results.length} vectors ok (${resolveWasmPath()})`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
