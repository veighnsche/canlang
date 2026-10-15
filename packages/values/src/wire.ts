/** Public wire facade. Type parsing and conversion run once in the TS core. */
import type { CanValue, RecordRef, WireValue } from "@canlang/contracts/values";
import { decodeValueTsCore, encodeValueTsCore } from "./internal/wire-core.js";

/** Decode to frozen canonical values; failures retain their original error. */
export function decodeValue(typeId: string, wire: unknown): CanValue {
  return decodeValueTsCore(typeId, wire);
}

/** Encode to frozen wire data; failures retain their original error. A host
 * may supply private record identities at demanded reference leaves, using
 * the existing readonly wire path to verify its owning type before erasure. */
export function encodeValue(typeId: string, value: CanValue,
  resolveReference: ((value: CanValue, path: ReadonlyArray<string | number>) => RecordRef | undefined) | undefined = undefined): WireValue {
  return encodeValueTsCore(typeId, value, resolveReference);
}
