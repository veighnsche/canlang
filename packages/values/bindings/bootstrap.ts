// Private host bootstrap: create/validate a backend once, before use.
//
// bootstrapWasm synchronously instantiates caller-supplied module bytes
// (Node/Bun load local bytes; a Worker entry passes its precompiled
// module through initSync the same way) and ABI-checks the glue before
// returning a backend. Every startup failure is a BootstrapError with a
// stable code; a failed bootstrap never installs a half-ready backend.
import { REQUIRED_ABI_VERSION, type ExactBackend, wasmBackend } from "./backend.js";
import { abi_version, exact_call, initSync } from "./generated/values_semantics.js";

export type BootstrapCode = "missing-bytes" | "init-failed" | "abi-mismatch";

export class BootstrapError extends Error {
  readonly code: BootstrapCode;

  constructor(code: BootstrapCode, message: string) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
  }
}

/**
 * Synchronously bootstraps the wasm backend from module bytes. Every
 * startup failure is a BootstrapError with a stable code.
 */
export function bootstrapWasm(bytes: Uint8Array): ExactBackend {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new BootstrapError("missing-bytes", "wasm bootstrap needs non-empty module bytes");
  }
  try {
    initSync({ module: bytes });
  } catch (err) {
    throw new BootstrapError(
      "init-failed",
      `wasm instantiation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const abi = abi_version();
  if (abi !== REQUIRED_ABI_VERSION) {
    throw new BootstrapError(
      "abi-mismatch",
      `wasm glue ABI is ${abi}, host requires ${REQUIRED_ABI_VERSION}`,
    );
  }
  return wasmBackend({ abi_version, exact_call });
}
