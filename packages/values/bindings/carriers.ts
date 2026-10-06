// Private host carriers: tagged-transport <-> native Can value conversion.
//
// Reconstruction goes through the real public constructors (Decimal,
// makeMoney/makeDate/makeDatetime), so provenance, freezing and BigInt
// parts match values built by the TS package itself. This module is
// private host scaffolding: it never changes src/ behavior or exports.
import type {
  DatetimeValue,
  DateValue,
  DecimalValue,
  MoneyValue,
} from "../../contracts/src/values.js";
import { Decimal, isDecimal } from "../src/decimal.js";
import { ValueError } from "../src/errors.js";
import {
  isDatetime,
  isDateValue,
  isMoney,
  makeDate,
  makeDatetime,
  makeMoney,
} from "../src/kinds.js";

/** Tagged JSON value, mirroring the native transport tags. */
export type Tagged =
  | { t: "bigint"; v: string }
  | { t: "num"; v: number | "NaN" | "Infinity" | "-Infinity" }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "undef" }
  | { t: "decimal"; coef: string; scale: number }
  | { t: "money"; minor: string; currency: string }
  | { t: "date"; year: number; month: number; day: number }
  | { t: "datetime"; ms: string }
  | { t: "array"; items: Tagged[] }
  | { t: "record"; entries: Array<[string, Tagged]> };

function tagNumber(value: number): Tagged {
  if (Number.isNaN(value)) return { t: "num", v: "NaN" };
  if (value === Infinity) return { t: "num", v: "Infinity" };
  if (value === -Infinity) return { t: "num", v: "-Infinity" };
  return { t: "num", v: value };
}

/** Converts a native Can value to its tagged transport form. */
export function tag(value: unknown): Tagged {
  if (typeof value === "bigint") return { t: "bigint", v: value.toString() };
  if (typeof value === "number") return tagNumber(value);
  if (typeof value === "string") return { t: "str", v: value };
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (value === null) return { t: "null" };
  if (value === undefined) return { t: "undef" };
  if (isDecimal(value)) {
    // Supported-profile boundary (A07-CARRIER-PIN): TS retains a -0
    // decimal scale as an observable carrier part (Object.is), but the
    // JSON transport erases it (JSON.stringify(-0) === "0") and the
    // native scale is u8. Refuse explicitly instead of silently
    // normalizing; the ts backend retains this path.
    if (Object.is(value.scale, -0)) {
      throw new ValueError(
        "invalid-construction",
        "decimal scale -0 is outside the wasm profile; use the ts backend",
      );
    }
    return { t: "decimal", coef: value.coef.toString(), scale: value.scale };
  }
  if (isMoney(value)) {
    return { t: "money", minor: value.minor.toString(), currency: value.currency };
  }
  if (isDateValue(value)) {
    return { t: "date", year: value.year, month: value.month, day: value.day };
  }
  if (isDatetime(value)) {
    return { t: "datetime", ms: value.ms.toString() };
  }
  if (Array.isArray(value)) {
    return { t: "array", items: value.map(tag) };
  }
  if (typeof value === "object") {
    const entries: Array<[string, Tagged]> = Object.entries(value).map(([k, v]) => [k, tag(v)]);
    return { t: "record", entries };
  }
  throw new ValueError("invalid-construction", "cannot tag host value for transport");
}

function untagNumber(v: number | string): number {
  if (v === "NaN") return NaN;
  if (v === "Infinity") return Infinity;
  if (v === "-Infinity") return -Infinity;
  if (typeof v !== "number") {
    throw new ValueError("invalid-construction", "malformed num tag in transport");
  }
  return v;
}

/**
 * Reconstructs a native Can value from its tagged form through the real
 * public constructors. Malformed tags are `invalid-construction`.
 */
export function reconstruct(tagged: Tagged): unknown {
  switch (tagged.t) {
    case "bigint":
      return BigInt(tagged.v);
    case "num":
      return untagNumber(tagged.v);
    case "str":
      return tagged.v;
    case "bool":
      return tagged.v;
    case "null":
      return null;
    case "undef":
      return undefined;
    case "decimal": {
      const out: DecimalValue = new Decimal(BigInt(tagged.coef), tagged.scale);
      return out;
    }
    case "money": {
      const out: MoneyValue = makeMoney(BigInt(tagged.minor), tagged.currency);
      return out;
    }
    case "date": {
      const out: DateValue = makeDate(tagged.year, tagged.month, tagged.day);
      return out;
    }
    case "datetime": {
      const out: DatetimeValue = makeDatetime(BigInt(tagged.ms));
      return out;
    }
    case "array":
      return tagged.items.map(reconstruct);
    case "record":
      return Object.fromEntries(tagged.entries.map(([k, v]) => [k, reconstruct(v)]));
  }
}
