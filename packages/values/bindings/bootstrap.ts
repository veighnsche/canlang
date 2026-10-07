// Private host bootstrap: create/validate a backend once, before use.
//
// bootstrapWasm synchronously instantiates caller-supplied module bytes
// (Node/Bun load local bytes; a Worker entry passes its precompiled
// module through initSync the same way) and ABI-checks the glue before
// returning a backend. Every startup failure is a BootstrapError with a
// stable code; a failed bootstrap never installs a half-ready backend.
import { REQUIRED_ABI_VERSION, type ExactBackend, wasmBackend } from "./backend.js";
import { abi_version, exact_call, initSync, type SyncInitInput } from "./generated/values_semantics.js";

export type BootstrapCode = "missing-bytes" | "init-failed" | "abi-mismatch";

export class BootstrapError extends Error {
  readonly code: BootstrapCode;

  constructor(code: BootstrapCode, message: string) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
  }
}

// The package deliberately has no DOM library dependency. The native
// constructor validates precompiled modules without structural duck typing.
const WasmModule: new (bytes: Uint8Array<ArrayBuffer>) => object =
  Reflect.get(globalThis, "WebAssembly").Module;
const WasmMemory: new (...args: never[]) => object =
  Reflect.get(globalThis, "WebAssembly").Memory;
const WasmTable: new (...args: never[]) => object =
  Reflect.get(globalThis, "WebAssembly").Table;
const nativeByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), "length",
)!.get!;
let initializedAsset: Uint8Array<ArrayBuffer> | object | undefined;

function sameAsset(asset: SyncInitInput): boolean {
  if (asset instanceof Uint8Array && initializedAsset instanceof Uint8Array) {
    if (asset.length !== initializedAsset.length) return false;
    for (let index = 0; index < asset.length; index += 1) {
      if (asset[index] !== initializedAsset[index]) return false;
    }
    return true;
  }
  return asset === initializedAsset;
}

/**
 * Synchronously bootstraps from Uint8Array bytes or a precompiled module.
 * Other generated-glue BufferSource variants are not admitted here.
 * Every startup failure is a BootstrapError with a stable code.
 */
export function bootstrapWasm(asset: SyncInitInput): ExactBackend {
  // The native typed-array copy uses the source's internal byte storage,
  // not caller-overridable every/iterator/length/buffer properties. Only
  // this private copy reaches comparison, instantiation and the asset pin.
  try {
    if (asset instanceof Uint8Array) {
      nativeByteLength.call(asset); // Reject proxies without typed-array internal storage.
      asset = new Uint8Array(asset);
    }
  } catch (err) {
    throw new BootstrapError("init-failed", `wasm byte copy failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!(asset instanceof WasmModule) && (!(asset instanceof Uint8Array) || asset.length === 0)) {
    throw new BootstrapError("missing-bytes", "wasm bootstrap needs non-empty module bytes or a compiled module");
  }
  // wasm-bindgen initSync reuses its first instance without inspecting
  // later inputs. Check identity here so changed/corrupt assets cannot be
  // silently accepted after successful startup. Module inputs use identity;
  // byte inputs use a private copy so caller mutation cannot change the pin.
  if (initializedAsset !== undefined) {
    if (!sameAsset(asset)) {
      throw new BootstrapError("init-failed", "wasm bootstrap asset differs from the initialized asset");
    }
    return wasmBackend({ abi_version, exact_call });
  }
  try {
    let consumed = false;
    const exports = initSync({ get module() { consumed = true; return asset; } });
    if (!consumed) {
      throw new Error("generated glue was initialized outside this bootstrap");
    }
    const abi = abi_version();
    if (abi !== REQUIRED_ABI_VERSION) {
      throw new BootstrapError(
        "abi-mismatch",
        `wasm glue ABI is ${abi}, host requires ${REQUIRED_ABI_VERSION}`,
      );
    }
    for (const name of ["abi_version", "exact_call", "__wbindgen_malloc", "__wbindgen_realloc", "__wbindgen_free", "__wbindgen_start"]) {
      if (typeof Reflect.get(exports, name) !== "function") {
        throw new Error(`wasm transport export ${name} is missing or has the wrong type`);
      }
    }
    if (!(exports.memory instanceof WasmMemory) || !(exports.__wbindgen_externrefs instanceof WasmTable)) {
      throw new Error("wasm transport memory or externref table is missing or has the wrong type");
    }
    const backend = wasmBackend({ abi_version, exact_call });
    initializedAsset = asset;
    return backend;
  } catch (err) {
    if (err instanceof BootstrapError) throw err;
    throw new BootstrapError(
      "init-failed",
      `wasm instantiation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
