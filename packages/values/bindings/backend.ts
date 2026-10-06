// Private backend registry: explicit ts/wasm-required selection.
//
// Both backends expose the same synchronous op call over native Can
// values. The ts backend dispatches straight to the TS package (usable
// with no bootstrap); the wasm backend round-trips through the generated
// glue. Can failures surface as ValueError with the original code and
// message on both sides. The smoke op table below is scaffolding; the
// full operation registry lands with A07.3 final assembly.
import { addDecimal, negateDecimal, type Decimal } from "../src/decimal.js";
import { ValueError, type ValueFailureCode } from "../src/errors.js";
import { addInt, negateInt } from "../src/int.js";
import type { DateValue, MoneyValue } from "@canlang/contracts/values";
import { addMoney } from "../src/money.js";
import { dateToEpochDays } from "../src/temporal.js";
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
      const fn = TS_OPS[op];
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

function throwFailure(op: string, response: FailureResponse): never {
  if (typeof response.transport === "string") {
    throw new ValueError("invalid-construction", `native transport fault on ${op}: ${response.transport}`);
  }
  if (response.violations !== undefined) {
    throw new ValueError("invalid-construction", `native decode violations on ${op}`);
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
