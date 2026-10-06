/**
 * Typed deployment-asset inventory (C04.asset, C-delivery lane).
 *
 * The deploy bundle carries two asset kinds: versioned text modules (the
 * v1 text-only serialization, byte-identical forever) and binary modules
 * (compiled Wasm today). This module owns the shared vocabulary both the
 * bundler and the host plumbing consume; it performs no I/O and imports
 * no Node builtins, so worker-side code may import these types.
 *
 * Digest versions:
 * - `ASSET_DIGEST_V1`: sha256 over `JSON.stringify({ mainModule, modules:
 *   sortedTextMap })` — the exact historical v1 text-only serialization.
 *   Text-only bundles MUST keep producing this digest byte-identically.
 * - `ASSET_DIGEST_V2`: sha256 over length-prefixed mixed frames, one per
 *   entry in key-sorted order: `u32be(keyBytes) + key + u8(kind: 1=text,
 *   2=binary) + u64be(byteLength) + rawBytes`. Binary lengths/hashes are
 *   exact: raw bytes in, same bytes out, no base64/text normalization.
 */

/** Asset digest versions. V1 is frozen; mixed bundles use V2. */
export const ASSET_DIGEST_V1 = "sha256-text-v1" as const;
export const ASSET_DIGEST_V2 = "sha256-mixed-v2" as const;
export type AssetDigestVersion = typeof ASSET_DIGEST_V1 | typeof ASSET_DIGEST_V2;

/** Deployment asset kinds. */
export type AssetKind = "text" | "binary";

/** A versioned text module (JS source, JSON, TOML, maps-as-text). */
export interface TextAsset {
  readonly kind: "text";
  /** Exact source text; written as UTF-8, hashed as UTF-8 bytes. */
  readonly text: string;
}

/** A binary module (compiled Wasm). Bytes are opaque and exact. */
export interface BinaryAsset {
  readonly kind: "binary";
  /** Raw module bytes; written verbatim, hashed verbatim. */
  readonly bytes: Uint8Array;
}

/** One typed deployment asset. */
export type DeploymentAsset = TextAsset | BinaryAsset;

/**
 * Typed inventory: module-map key -> asset. Keys use the same
 * module-map-relative convention as the bundle (`worker/...`,
 * `runtime/...`, `vendor/...`).
 */
export type AssetInventory = Record<string, DeploymentAsset>;

/**
 * Pinned installed module-type mapping, verified against the installed
 * miniflare API (miniflare@4.20260730.0 `CoreOptionsSchema`: module
 * `type` enum + `contents?: string | Uint8Array`). Text assets stage as
 * `ESModule` with string contents; binary Wasm assets stage as
 * `CompiledWasm` with `Uint8Array` contents. No other mapping is
 * permitted without re-verifying the installed API.
 */
export const ESMODULE_TYPE = "ESModule" as const;
export const COMPILED_WASM_MODULE_TYPE = "CompiledWasm" as const;
export type InstalledModuleType = typeof ESMODULE_TYPE | typeof COMPILED_WASM_MODULE_TYPE;

/** Map one asset to its installed module type. Total: text->ESModule, binary->CompiledWasm. */
export function installedModuleTypeFor(asset: DeploymentAsset): InstalledModuleType {
  return asset.kind === "binary" ? COMPILED_WASM_MODULE_TYPE : ESMODULE_TYPE;
}

/** Exact byte length of one asset (UTF-8 length for text, raw length for binary). */
export function assetByteLength(asset: DeploymentAsset): number {
  if (asset.kind === "binary") return asset.bytes.length;
  return new TextEncoder().encode(asset.text).length;
}

/** True when every inventory entry is text (v1 text-only fast path applies). */
export function isTextOnlyInventory(inventory: AssetInventory): boolean {
  return Object.values(inventory).every((asset) => asset.kind === "text");
}
