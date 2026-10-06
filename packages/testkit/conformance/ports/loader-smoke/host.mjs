/**
 * C04.1 loader-smoke host: synchronous startup/call + failure vectors.
 *
 * Loads the precompiled binding built from this fixture's crate
 * (`cargo build --locked --target wasm32-unknown-unknown --release`;
 * bytes at `target/wasm32-unknown-unknown/release/loader_smoke.wasm`
 * or `$LOADER_SMOKE_WASM`), starts it SYNCHRONOUSLY (no async
 * instantiate, no fallback), calls both exports, then proves the three
 * failure vectors fail: missing module, corrupt bytes, wrong ABI
 * (a module without the smoke exports). Any deviation exits nonzero
 * with the failing vector id. Dependency-free: runs under Node and Bun.
 *
 * Usage: `node host.mjs` or `bun host.mjs` (exit 0 = all vectors pass).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WASM = path.join(
  HERE, 'target', 'wasm32-unknown-unknown', 'release', 'loader_smoke.wasm',
);
/** Smallest valid Wasm module: instantiates, exports nothing (wrong ABI). */
const EMPTY_MODULE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

export function resolveWasmPath() {
  return process.env.LOADER_SMOKE_WASM ?? DEFAULT_WASM;
}

/**
 * Synchronous startup: read bytes, compile, instantiate with no
 * imports. Throws `{ code }` failures, never falls back.
 */
export function loadBinding(wasmPath) {
  if (!existsSync(wasmPath)) {
    throw { code: 'module/missing', path: wasmPath }; // eslint-disable-line no-throw-literal
  }
  const bytes = readFileSync(wasmPath);
  let module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch {
    throw { code: 'module/corrupt', path: wasmPath }; // eslint-disable-line no-throw-literal
  }
  const instance = new WebAssembly.Instance(module, {});
  const { smoke_version, smoke_add } = instance.exports;
  if (typeof smoke_version !== 'function' || typeof smoke_add !== 'function') {
    throw { code: 'module/wrong-abi', path: wasmPath }; // eslint-disable-line no-throw-literal
  }
  return { smoke_version, smoke_add };
}

export function loadBindingBytes(bytes, label) {
  let module;
  try {
    module = new WebAssembly.Module(bytes);
  } catch {
    throw { code: 'module/corrupt', path: label }; // eslint-disable-line no-throw-literal
  }
  const instance = new WebAssembly.Instance(module, {});
  const { smoke_version, smoke_add } = instance.exports;
  if (typeof smoke_version !== 'function' || typeof smoke_add !== 'function') {
    throw { code: 'module/wrong-abi', path: label }; // eslint-disable-line no-throw-literal
  }
  return { smoke_version, smoke_add };
}

function check(name, actual, expected) {
  if (!Object.is(actual, expected)) {
    throw {
      code: 'vector/mismatch', // eslint-disable-line no-throw-literal
      vector: name, actual, expected,
    };
  }
  return { vector: name, ok: true };
}

function checkThrows(name, expectedCode, fn) {
  try {
    fn();
  } catch (err) {
    if (err?.code === expectedCode) return { vector: name, ok: true, code: err.code };
    throw { // eslint-disable-line no-throw-literal
      code: 'vector/wrong-failure', vector: name, expected: expectedCode, actual: err?.code,
    };
  }
  throw { code: 'vector/no-failure', vector: name, expected: expectedCode }; // eslint-disable-line no-throw-literal
}

export function runSmoke(wasmPath = resolveWasmPath()) {
  const results = [];
  // Sync startup + calls against the real precompiled binding.
  const binding = loadBinding(wasmPath);
  results.push(check('startup/version-is-transport-v0', binding.smoke_version(), 0));
  results.push(check('call/add-basics', binding.smoke_add(40, 2), 42));
  results.push(check('call/add-wraps', binding.smoke_add(2147483647, 1), -2147483648));
  // Failure vectors: each MUST fail with its code; no fallback.
  results.push(checkThrows('failure/missing-module', 'module/missing', () =>
    loadBinding(path.join(HERE, 'does-not-exist.wasm'))));
  const good = new Uint8Array(readFileSync(wasmPath));
  const corrupt = good.slice();
  corrupt[4] ^= 0xff; // mangle the version field, keep the magic
  results.push(checkThrows('failure/corrupt-bytes', 'module/corrupt', () =>
    loadBindingBytes(corrupt, '<mangled-version>')));
  results.push(checkThrows('failure/wrong-abi', 'module/wrong-abi', () =>
    loadBindingBytes(EMPTY_MODULE, '<empty-module>')));
  return results;
}

const invokedAsMain = process.argv[1] !== undefined
  && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedAsMain) {
  try {
    const results = runSmoke();
    console.log(`loader-smoke: ${results.length} vectors ok (${resolveWasmPath()})`);
  } catch (err) {
    console.error(JSON.stringify(err));
    process.exitCode = 1;
  }
}
