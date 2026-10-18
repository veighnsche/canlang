// Private backend registry: explicit ts/wasm-required selection.
//
// Both backends expose the same synchronous op call over native Can
// values. The ts backend dispatches straight to the TS package (usable
// with no bootstrap); the wasm backend round-trips through the generated
// glue. Can failures surface as ValueError with the original code and
// message on both sides. The smoke op table below is scaffolding; the
// full operation registry lands with A07.3 final assembly.
import { addDecimal, negateDecimal, type Decimal } from "../src/decimal.js";
import { SchemaError, ValueError, type ValueFailureCode } from "../src/errors.js";
import { addInt, INT64_MAX, INT64_MIN, negateInt } from "../src/int.js";
import type { CanValue, DateValue, MoneyValue, Violation, ViolationCode } from "@canlang/contracts/values";
import { addMoney } from "../src/money.js";
import { dateToEpochDays } from "../src/temporal.js";
import { decodeValueTsCore, encodeValueTsCore } from "../src/internal/wire-core.js";
import { reconstruct, tag, type Tagged } from "./carriers.js";

export type BackendName = "ts" | "wasm";

/** Transport ABI version the host side requires from the glue. */
export const REQUIRED_ABI_VERSION = 1;

export interface ExactBackend {
  readonly name: BackendName;
  /** Synchronous op call over native Can values; throws ValueError. */
  call(op: string, args: unknown[]): unknown;
}

type SmokeFn = (...args: never[]) => unknown;

/** Smoke op table (scaffold): fixed entries, not the A07.3 registry. */
const TS_OPS: Record<string, SmokeFn> = {
  "add-int": ((a: unknown, b: unknown) => addInt(a as bigint, b as bigint)) as SmokeFn,
  "negate-int": ((a: unknown) => negateInt(a as bigint)) as SmokeFn,
  "add-decimal": ((a: unknown, b: unknown) =>
    addDecimal(a as Decimal | bigint, b as Decimal | bigint)) as SmokeFn,
  // Retains -0 scales (carrier pin control); the wasm path refuses them.
  "negate-decimal": ((a: unknown) => negateDecimal(a as Decimal)) as SmokeFn,
  "date-to-epoch-days": ((a: unknown) => dateToEpochDays(a as DateValue)) as SmokeFn,
  "add-money": ((a: unknown, b: unknown) =>
    addMoney(a as MoneyValue, b as MoneyValue)) as SmokeFn,
};

/** Direct-TS backend: works with no bootstrap and no built glue. */
export function tsBackend(): ExactBackend {
  return {
    name: "ts",
    call(op: string, args: unknown[]): unknown {
      const fn = Object.hasOwn(TS_OPS, op) ? TS_OPS[op] : undefined;
      if (!fn) {
        throw new ValueError("invalid-construction", `smoke backend has no op: ${op}`);
      }
      return (fn as (...a: unknown[]) => unknown)(...args);
    },
  };
}

/** Minimal structural shape of the generated wasm-bindgen glue. */
export interface WasmGlue {
  abi_version(): number;
  exact_call(requestJson: string): string;
}

interface FailureResponse {
  ok: boolean;
  code?: string;
  message?: string;
  violations?: unknown;
  transport?: string;
}

const NATIVE_VIOLATION_CODES: ReadonlySet<string> = new Set([
  "required",
  "type",
  "format",
  "bound",
  "unknown-field",
  "unknown-argument",
  "limit",
]);

function isViolationPath(path: unknown): path is Array<string | number> {
  return (
    Array.isArray(path) &&
    path.every((seg) => typeof seg === "string" || typeof seg === "number")
  );
}

/**
 * Projects one native ordered violation list through the owning
 * SchemaError facade, preserving path/code/message and the present/absent
 * expected/actual fields in wire order. Non-violation payloads are a
 * transport-shape fault, never a semantic decode.
 */
export function nativeViolationsToSchemaError(violations: unknown): SchemaError {
  if (!Array.isArray(violations)) {
    throw new ValueError("invalid-construction", "native violations payload is not an array");
  }
  const out: Violation[] = violations.map((item) => {
    const record = item as { path?: unknown; code?: unknown; message?: unknown; expected?: unknown; actual?: unknown };
    if (
      typeof record !== "object" ||
      record === null ||
      !isViolationPath(record.path) ||
      typeof record.code !== "string" ||
      !NATIVE_VIOLATION_CODES.has(record.code) ||
      typeof record.message !== "string" ||
      (record.expected !== undefined && typeof record.expected !== "string") ||
      (record.actual !== undefined && typeof record.actual !== "string")
    ) {
      throw new ValueError("invalid-construction", "native violation has a malformed shape");
    }
    return {
      path: [...record.path],
      code: record.code as ViolationCode,
      message: record.message,
      ...(record.expected !== undefined ? { expected: record.expected } : null),
      ...(record.actual !== undefined ? { actual: record.actual } : null),
    };
  });
  return new SchemaError(out);
}

function throwFailure(op: string, response: FailureResponse): never {
  if (typeof response.transport === "string") {
    throw new ValueError("invalid-construction", `native transport fault on ${op}: ${response.transport}`);
  }
  if (response.violations !== undefined) {
    throw nativeViolationsToSchemaError(response.violations);
  }
  throw new ValueError(
    (response.code as ValueFailureCode | undefined) ?? "invalid-construction",
    response.message ?? `native failure on ${op}`,
  );
}

/**
 * Wasm backend over caller-supplied glue. The ABI version is checked at
 * construction: a mismatched module fails here, never mid-request.
 */
export function wasmBackend(glue: WasmGlue): ExactBackend {
  const abi = glue.abi_version();
  if (abi !== REQUIRED_ABI_VERSION) {
    throw new ValueError(
      "invalid-construction",
      `wasm glue ABI is ${abi}, host requires ${REQUIRED_ABI_VERSION}`,
    );
  }
  return {
    name: "wasm",
    call(op: string, args: unknown[]): unknown {
      const request = JSON.stringify({ v: 1, op, args: args.map(tag) });
      const raw = glue.exact_call(request);
      const response = JSON.parse(raw) as {
        ok: boolean;
        value?: Tagged;
        code?: string;
        message?: string;
        violations?: unknown;
        transport?: string;
      };
      if (!response.ok) throwFailure(op, response);
      return reconstruct(response.value as Tagged);
    },
  };
}

/**
 * Selected int/ASCII admission: the released named CSV raw/text bound in
 * bytes. ASCII text is one byte per unit, so length is the byte count.
 */
export const SELECTED_INT_TEXT_MAX_BYTES = 1_048_576;

const SELECTED_INT64_MIN = "-9223372036854775808";
const SELECTED_INT64_MAX = "9223372036854775807";

function isAsciiText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) return false;
  }
  return true;
}

/**
 * Escaped UTF-16 unit length of one ASCII code unit under
 * `JSON.stringify`, mirroring its exact escape table (`\"`, `\\`,
 * `\b \t \n \f \r`, `\u00xx` lowercase, everything else raw).
 */
function jsonEscapeLength(code: number): number {
  if (code === 0x22 || code === 0x5c) return 2;
  if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return 2;
  if (code < 0x20) return 6;
  return 1;
}

function jsonEscapeAscii(code: number): string {
  switch (code) {
    case 0x22: return '\\"';
    case 0x5c: return '\\\\';
    case 0x08: return '\\b';
    case 0x09: return '\\t';
    case 0x0a: return '\\n';
    case 0x0c: return '\\f';
    case 0x0d: return '\\r';
    default:
      if (code < 0x20) return `\\u00${code.toString(16).padStart(2, "0")}`;
      return String.fromCharCode(code);
  }
}

/**
 * `actual` rendering identical to `JSON.stringify(wire)` truncated at 64
 * UTF-16 units plus `...`, computed with bounded work: an O(n) unit
 * scan with O(64) allocation, never a whole-string stringify of an
 * over-budget payload. ASCII-only (the only domain that reaches this
 * pre-entry refusal; every unit is one char).
 */
function boundedStringifiedActual(wire: string): string {
  let total = 2;
  for (let index = 0; index < wire.length; index += 1) {
    total += jsonEscapeLength(wire.charCodeAt(index));
  }
  if (total <= 64) return JSON.stringify(wire);
  let out = '"';
  let units = 1;
  for (let index = 0; index < wire.length && units < 64; index += 1) {
    let esc = jsonEscapeAscii(wire.charCodeAt(index));
    if (units + esc.length > 64) esc = esc.slice(0, 64 - units);
    out += esc;
    units += esc.length;
  }
  return `${out}...`;
}

/**
 * Explicit opt-in selection for the selected int producer. Null (the
 * default) keeps the full-domain TypeScript route; installing a backend
 * selects the genuine native producer for admitted ASCII text only.
 */
let selectedIntBackend: ExactBackend | null = null;

export function selectSelectedIntBackend(backend: ExactBackend | null): void {
  selectedIntBackend = backend;
}

/**
 * Selected int decode at the owning codec entry. Non-ASCII or non-string
 * wire stays on the full-domain TypeScript route before any native
 * evaluation. Admitted ASCII text is byte-checked before tag/JSON
 * allocation; over-bound text refuses as a SchemaError with no accepted
 * value, effect, or retry.
 */
export function decodeSelectedInt(wire: unknown): bigint {
  const backend = selectedIntBackend;
  if (backend === null || !isAsciiText(wire)) {
    return decodeValueTsCore("int", wire) as bigint;
  }
  if (wire.length > SELECTED_INT_TEXT_MAX_BYTES) {
    throw new SchemaError([{
      path: [],
      code: "bound",
      message: "int is out of range",
      expected: `int in [${SELECTED_INT64_MIN}, ${SELECTED_INT64_MAX}]`,
      actual: boundedStringifiedActual(wire),
    }]);
  }
  return backend.call("decode-value", ["int", wire]) as bigint;
}

/**
 * Selected int encode at the owning codec entry: the normalized decimal
 * string for the actual in-range bigint yielded by selected decode.
 * Non-bigint values stay on the TypeScript route; native failures throw
 * with their original code and message and never retry.
 */
/**
 * Magnitude class bound for the encode diagnostic: values within it
 * render full digits (exact native parity); beyond it the message stays
 * bounded instead of materializing millions of digits.
 */
const ENCODE_DIAGNOSTIC_LIMIT = 10n ** 26n;

export function encodeSelectedInt(value: unknown): string {
  const backend = selectedIntBackend;
  if (backend === null || typeof value !== "bigint") {
    return encodeValueTsCore("int", value as CanValue) as string;
  }
  // Signed64 admission before any tag/JSON/native bigint work: bigint
  // magnitude comparison allocates nothing. The failure keeps the
  // native invalid-construction code and message shape with no retry.
  if (value < INT64_MIN || value > INT64_MAX) {
    const huge = value < -ENCODE_DIAGNOSTIC_LIMIT || value > ENCODE_DIAGNOSTIC_LIMIT;
    throw new ValueError(
      "invalid-construction",
      huge ? "int out of 64-bit range: bigint exceeds 26 digits at $"
        : `int out of 64-bit range: ${value} at $`,
    );
  }
  const out = backend.call("encode-value", ["int", value]);
  if (typeof out !== "string") {
    throw new ValueError("invalid-construction", "native int encode did not return text");
  }
  return out;
}
