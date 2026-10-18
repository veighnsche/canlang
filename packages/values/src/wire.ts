/** Public wire facade. Type parsing and conversion run once in the TS core. */
import type { CanValue, RecordRef, WireValue } from "@canlang/contracts/values";
import {
  decodeSelectedInt,
  encodeSelectedInt,
  selectedExactBackendRead,
} from "../bindings/backend.js";
import { NOT_ROUTED, routeExact } from "../bindings/exact-route.js";
import { decodeValueTsCore, encodeValueTsCore } from "./internal/wire-core.js";
import type { NormalizedSchema } from "./schema.js";
import { parseTypeId } from "./types.js";

/**
 * Scalar names the native codecs serve (the selected decode/encode
 * scope). `text`/`bool` stay TypeScript-owned: the native dispatch has no
 * matching scalar, so routing them would trade TS behavior for a
 * transport fault.
 */
const NATIVE_SCALARS: ReadonlySet<string> = new Set([
  "int",
  "decimal",
  "money",
  "date",
  "datetime",
  "duration",
]);

/**
 * Admits one bare selected scalar name, or null. Admission parses the
 * type id BEFORE any payload or backend evaluation, so non-string type
 * ids keep the original TypeScript error and bogus ids keep the legacy
 * parse error; anything outside the bare six-scalar scope stays on the
 * full-domain TypeScript route. Reads no payload: throwing getters in
 * the wire value never fire during admission.
 */
function admittedScalar(typeId: string): string | null {
  if (selectedExactBackendRead() === null) return null;
  const ast = parseTypeId(typeId);
  if (ast.array || ast.nullable || ast.requiredArray) return null;
  if (ast.base.kind !== "scalar" || !NATIVE_SCALARS.has(ast.base.name)) return null;
  return ast.base.name;
}

/** Decode to frozen canonical values; failures retain their original error. */
export function decodeValue(typeId: string, wire: unknown): CanValue {
  const scalar = admittedScalar(typeId);
  if (scalar === null) {
    // Only the int-specific profile may still apply; it keeps the
    // TypeScript route itself when uninstalled.
    if (typeId === "int") return decodeSelectedInt(wire);
    return decodeValueTsCore(typeId, wire);
  }
  // The owning selected-int entries are the real int consumer path
  // (TECH-V04 admission bound); the raw pipe would bypass it.
  if (scalar === "int") return decodeSelectedInt(wire);
  const routed = routeExact<CanValue>("decode-value", [typeId, wire]);
  if (routed !== NOT_ROUTED) return routed;
  return decodeValueTsCore(typeId, wire);
}

/** Encode to frozen wire data; failures retain their original error. A host
 * may supply private record identities at demanded reference leaves, using
 * the existing readonly wire path to verify its owning type before erasure.
 * An owning schema preserves declared Contract business fields and recursively
 * encodes their declared types before considering runtime value tags. */
export function encodeValue(typeId: string, value: CanValue,
  resolveReference: ((value: CanValue, path: ReadonlyArray<string | number>) => RecordRef | undefined) | undefined = undefined, schema: NormalizedSchema | undefined = undefined): WireValue {
  const scalar = admittedScalar(typeId);
  // Reference resolution and schema-preserving encode have no native
  // counterpart; admitted or not, they stay on the TypeScript route.
  if (scalar === null || resolveReference !== undefined || schema !== undefined) {
    if (typeId === "int" && resolveReference === undefined && schema === undefined) {
      return encodeSelectedInt(value);
    }
    return encodeValueTsCore(typeId, value, resolveReference, schema);
  }
  if (scalar === "int") return encodeSelectedInt(value);
  const routed = routeExact<WireValue>("encode-value", [typeId, value]);
  if (routed !== NOT_ROUTED) return routed;
  return encodeValueTsCore(typeId, value, resolveReference, schema);
}
