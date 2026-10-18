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
} from "@canlang/contracts/values";
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

/**
 * Tagged JSON value, mirroring the native transport tags. `str16` carries
 * ill-formed UTF-16 text (lone surrogates) as code units so it survives
 * transport losslessly; well-formed text always uses `str`. Record keys
 * use the same split: a plain string, or `{ k16: [...] }` for ill-formed
 * keys. Decimal scales ride as JS numbers with `-0` preserved end to end
 * (the request serializer emits the `-0` literal; serde and `JSON.parse`
 * both preserve its sign).
 */
export type Tagged =
  | { t: "bigint"; v: string }
  | { t: "num"; v: number | "NaN" | "Infinity" | "-Infinity" }
  | { t: "str"; v: string }
  | { t: "str16"; v: number[] }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "undef" }
  | { t: "decimal"; coef: string; scale: number }
  | { t: "money"; minor: string; currency: string }
  | { t: "date"; year: number; month: number; day: number }
  | { t: "datetime"; ms: string }
  | { t: "array"; items: Tagged[] }
  | { t: "record"; entries: Array<[string | { k16: number[] }, Tagged]> };

/** Lone-surrogate detector: true when the string is not well-formed UTF-16. */
export function hasLoneSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** UTF-16 code units of a string, lone surrogates kept as-is. */
export function codeUnits(value: string): number[] {
  const out: number[] = new Array<number>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    out[index] = value.charCodeAt(index);
  }
  return out;
}

/** Restores a string from code units, lone surrogates kept as-is. */
export function fromCodeUnits(units: ReadonlyArray<number>): string {
  let out = "";
  for (let index = 0; index < units.length; index += 8192) {
    out += String.fromCharCode(...units.slice(index, index + 8192));
  }
  return out;
}

/** Lossy UTF-16 decode mirroring Rust `String::from_utf16_lossy`. */
export function lossyFromUnits(units: ReadonlyArray<number>): string {
  return fromCodeUnits(units).replace(
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    "�",
  );
}

function tagNumber(value: number): Tagged {
  if (Number.isNaN(value)) return { t: "num", v: "NaN" };
  if (value === Infinity) return { t: "num", v: "Infinity" };
  if (value === -Infinity) return { t: "num", v: "-Infinity" };
  return { t: "num", v: value };
}

/** Converts a string to its tagged transport form, splitting ill-formed text. */
export function tagString(value: string): Tagged {
  return hasLoneSurrogates(value) ? { t: "str16", v: codeUnits(value) } : { t: "str", v: value };
}

/** Converts a record key to its tagged form, splitting ill-formed keys. */
export function tagKey(key: string): string | { k16: number[] } {
  return hasLoneSurrogates(key) ? { k16: codeUnits(key) } : key;
}

/** Converts a native Can value to its tagged transport form. Decimal `-0`
 * scales ride through untouched: the request serializer emits the `-0`
 * literal and the native core stores the sign, so the wasm path preserves
 * them exactly like the ts path. */
export function tag(value: unknown): Tagged {
  if (typeof value === "bigint") return { t: "bigint", v: value.toString() };
  if (typeof value === "number") return tagNumber(value);
  if (typeof value === "string") return tagString(value);
  if (typeof value === "boolean") return { t: "bool", v: value };
  if (value === null) return { t: "null" };
  if (value === undefined) return { t: "undef" };
  if (isDecimal(value)) {
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
    const entries: Array<[string | { k16: number[] }, Tagged]> = Object.entries(value).map(
      ([k, v]) => [tagKey(k), tag(v)],
    );
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
 * public constructors. Malformed tags are `invalid-construction`. `-0`
 * decimal scales survive `JSON.parse` (which preserves the sign), so the
 * constructor observes them exactly as produced.
 */
export function reconstruct(tagged: Tagged): unknown {
  switch (tagged.t) {
    case "bigint":
      return BigInt(tagged.v);
    case "num":
      return untagNumber(tagged.v);
    case "str":
      return tagged.v;
    case "str16":
      return fromCodeUnits(tagged.v);
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
      return Object.freeze(tagged.items.map(reconstruct));
    case "record":
      return Object.freeze(
        Object.fromEntries(
          tagged.entries.map(([k, v]) => [
            typeof k === "string" ? k : fromCodeUnits(k.k16),
            reconstruct(v),
          ]),
        ),
      );
  }
}
