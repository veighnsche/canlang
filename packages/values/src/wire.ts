/** Public wire facade. Type parsing and conversion run once in the TS core. */
import type { CanValue, WireValue } from "@canlang/contracts/values";
import { decodeValueTsCore, encodeValueTsCore } from "./internal/wire-core.js";

/** Decode to frozen canonical values; failures retain their original error. */
export function decodeValue(typeId: string, wire: unknown): CanValue {
  return decodeValueTsCore(typeId, wire);
}

/** Encode to frozen wire data; failures retain their original error. */
export function encodeValue(typeId: string, value: CanValue): WireValue {
  return encodeValueTsCore(typeId, value);
}
