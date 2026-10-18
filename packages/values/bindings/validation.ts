// Host side of the structural scaffold binding (V03.5).
//
// Wraps caller-supplied generated glue (init owned by bootstrap):
// versioned scaffold requests in, parsed values out. Scaffold
// failures surface as StructuralError carrying the envelope's stage,
// code and optional check — never silent, never retried.
import type { CanValue, WireValue } from "@canlang/contracts/values";
import { SchemaError } from "../src/errors.js";
import { decodeValueTsCore, encodeValueTsCore } from "../src/internal/wire-core.js";
import type { ExactBackend } from "./backend.js";
import { frameForWireValue, textUnits } from "./owned-input.js";

/**
 * Genuine exact-scalar codec capability, fixed before evaluation.
 *
 * The deferred-leaf join decodes leaf inputs and encodes canonical
 * values ONLY through the capability carried in its validation
 * context — never through the public `decodeValue`/`encodeValue`
 * facades, which consult a separate global exact-backend selection
 * that a supplied native `ValidationBackend` does not install. The
 * silent TypeScript computation that gap allowed is closed by
 * construction: the installed consumer path selects the capability
 * once, up front. Failures keep the existing no-fallback contract
 * (recorded as replayed violations, never retried or substituted).
 */
export interface ExactCodecCapability {
  /** Decodes one leaf wire value to its canonical value; throws on refusal. */
  decode(leaf: string, wire: unknown): CanValue;
  /** Encodes one canonical value back to its wire form. */
  encode(leaf: string, value: CanValue): WireValue;
}

/** Local TypeScript-core capability: the deterministic default when
 * the caller carries no installed selection. Reads no global state. */
const TS_CORE_CODEC: ExactCodecCapability = {
  decode: (leaf, wire) => decodeValueTsCore(leaf, wire),
  encode: (leaf, value) => encodeValueTsCore(leaf, value),
};

/**
 * Binds the genuine selected exact backend as the join capability:
 * one `decode-value`/`encode-value` call per leaf through the
 * installed backend, failures propagating with no post-failure
 * TypeScript retry. Capture once at installation; the join never
 * re-reads selection itself.
 */
export function exactCodecFromBackend(backend: ExactBackend): ExactCodecCapability {
  return {
    decode: (leaf, wire) => backend.call("decode-value", [leaf, wire]) as CanValue,
    encode: (leaf, value) => backend.call("encode-value", [leaf, value]) as WireValue,
  };
}

export const REQUIRED_STRUCTURAL_ABI = 1;

export type StructuralStage = "transport" | "plan";

/** Minimal structural shape of the generated scaffold glue. */
export interface ValidationGlue {
  structural_abi_version(): number;
  validation_call(requestJson: string): string;
}

export class StructuralError extends Error {
  readonly stage: StructuralStage;
  readonly code: string;
  readonly check?: string;

  constructor(stage: StructuralStage, code: string, check?: string) {
    super(`structural ${stage} failure: ${code}${check === undefined ? "" : ` (${check})`}`);
    this.name = "StructuralError";
    this.stage = stage;
    this.code = code;
    if (check !== undefined) {
      this.check = check;
    }
  }
}

export interface ValidationBackend {
  /** Synchronous scaffold call; throws StructuralError on envelope failure. */
  call(op: string, args: Record<string, unknown>): unknown;
}

/** One ordered violation record from native execution. */
export interface OwnedViolation {
  readonly path: ReadonlyArray<{ k: readonly number[] } | { i: number }>;
  readonly code: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** Whole-profile execution outcome (never a partial value on failure). */
export type OwnedOutcome =
  | { readonly outcome: "valid"; readonly value: unknown }
  | { readonly outcome: "invalid"; readonly violations: readonly OwnedViolation[] }
  | {
    readonly outcome: "deferred";
    readonly reason: string;
    readonly detail: string;
    /** Resolvable exact leaf: the scalar kind to decode plus the
     * value path of the leaf input. Absent for every other
     * deferral, which passes through unresolved. */
    readonly leaf?: string;
    readonly path?: OwnedViolation["path"];
    /** Declared array shape of the enclosing field: the host checks
     * wire array-ness against this before decoding. Absent on
     * deferrals from older backends, which keep the previous
     * dispatch. */
    readonly array?: boolean;
  }
  | { readonly outcome: "limit"; readonly code: string; readonly check: string };

/** Execution target: a contract value in a mode, or an operation call. */
export type OwnedTarget =
  | { readonly kind: "contract"; readonly name: string; readonly mode: "create" | "update" }
  | { readonly kind: "operation"; readonly name: string };

/**
 * Registration-time coverage selection for one plan target (the
 * `values.coverage` query): fully covered targets and directly
 * resolvable exact leaves select native execution (the latter through
 * the host resolve join); every other gap selects the explicit
 * TS-only path. Installers record this per operation; handlers honor
 * it and never silently re-decide coverage at runtime.
 */
export type OwnedSelection =
  | { readonly kind: "native"; readonly join: boolean; readonly detail: string }
  | { readonly kind: "ts-only"; readonly reason: string; readonly detail: string };

/**
 * Queries the registration-time coverage selection for one plan
 * target: no arena is built and no request begins. Throws
 * StructuralError on envelope failure, like every scaffold call.
 */
export function classifyOwnedSelection(
  backend: ValidationBackend,
  args: { readonly owner: number; readonly plan: string; readonly profile: "values/v1"; readonly target: OwnedTarget },
): OwnedSelection {
  const report = backend.call("values.coverage", {
    owner: args.owner,
    plan: args.plan,
    profile: args.profile,
    target:
      args.target.kind === "contract"
        ? { kind: "contract", name: args.target.name, mode: args.target.mode }
        : { kind: "operation", name: args.target.name },
  }) as {
    readonly covered: boolean;
    readonly reason?: string;
    readonly detail?: string;
    readonly leaf?: string;
    readonly path?: OwnedViolation["path"];
    readonly array?: boolean;
  };
  if (report.covered) {
    return { kind: "native", join: false, detail: "target is fully covered natively" };
  }
  const reason = report.reason ?? "unknown";
  const detail = report.detail ?? "target reaches an uncovered leaf";
  if (reason === "exact-codec" && typeof report.leaf === "string") {
    return { kind: "native", join: true, detail };
  }
  return { kind: "ts-only", reason, detail };
}

export interface OwnedExecution {
  readonly owner: number;
  readonly plan: string;
  /** Frame JSON built from parser-owned data (see owned-input frame join). */
  readonly frame: unknown;
  readonly budgets: { readonly nodes: number; readonly depth: number; readonly text: number; readonly entries: number };
  readonly profile: "values/v1";
  readonly target: OwnedTarget;
}

/**
 * Begins one owned request: gates handles, builds the checked arena
 * and retains it server-side. The returned id is closed over by
 * `withOwnedRequest`, which always disposes it.
 */
export function beginOwnedRequest(backend: ValidationBackend, args: {
  readonly owner: number;
  readonly plan: string;
  readonly frame: unknown;
  readonly budgets: OwnedExecution["budgets"];
}): number {
  const value = backend.call("request.begin", {
    owner: args.owner,
    plan: args.plan,
    frame: args.frame,
    budgets: args.budgets,
  }) as { readonly request: number };
  return value.request;
}

/** One admitted resolved leaf for `values.execute`: the value path
 * in violation segment encoding plus exactly one of a canonical
 * frame (genuine host decode) or replayed violations (failed
 * decode); neither marks a native-decides leaf (absent/null input,
 * where nullability and omission stay native duties). */
export interface ResolvedLeafEntry {
  readonly path: OwnedViolation["path"];
  readonly frame?: unknown;
  readonly violations?: ReadonlyArray<{
    readonly path: OwnedViolation["path"];
    readonly code: string;
    readonly message: string;
    readonly expected?: string;
    readonly actual?: string;
  }>;
}

/** Executes one whole profile action against a live request. */
export function executeOwnedRequest(
  backend: ValidationBackend,
  request: number,
  profile: "values/v1",
  target: OwnedTarget,
  resolved?: readonly ResolvedLeafEntry[],
): OwnedOutcome {
  return backend.call("values.execute", {
    request,
    profile,
    target,
    ...(resolved === undefined ? {} : { resolved }),
  }) as OwnedOutcome;
}

/** Disposes one request. Idempotent: unknown ids are silent no-ops. */
export function disposeOwnedRequest(backend: ValidationBackend, request: number): void {
  backend.call("request.dispose", { request });
}

/** Owner plan load: one owner scope plus one normalized schema with
 * factory provenance, registered in order. The owner scope carries the
 * family profile (`values`); the plan carries the execution profile
 * (`values/v1`) that `values.execute` must match. Threading all three
 * through both calls is the loader's only job; every gate (provenance,
 * stale scope, carried shape duties, registry bound) stays native. */
export interface OwnerPlanLoad {
  readonly abi: string;
  readonly profile: string;
  readonly planProfile: string;
  readonly backend: string;
  readonly owner_rev: string;
  readonly bound: number;
  readonly schema: Record<string, unknown>;
  readonly provenance: { readonly factory: string; readonly owner_rev: string };
}

export function loadOwnerPlan(
  via: ValidationBackend,
  load: OwnerPlanLoad,
): { owner: number; id: string } {
  const created = via.call("owner.create", {
    abi: load.abi,
    profile: load.profile,
    backend: load.backend,
    owner_rev: load.owner_rev,
    bound: load.bound,
  }) as { owner: number };
  const registered = via.call("plan.register", {
    owner: created.owner,
    profile: load.planProfile,
    schema: load.schema,
    provenance: load.provenance,
  }) as { id: string };
  return { owner: created.owner, id: registered.id };
}

/**
 * Runs one whole profile action with request-scoped cleanup. The
 * request is disposed in `finally`, covering success, error and
 * cancellation. No semantic operation is retried after a failure.
 */
export function withOwnedRequest<T>(
  backend: ValidationBackend,
  execution: OwnedExecution,
  run: (outcome: OwnedOutcome) => T,
): T {
  const request = beginOwnedRequest(backend, execution);
  try {
    return run(executeOwnedRequest(backend, request, execution.profile, execution.target));
  } finally {
    disposeOwnedRequest(backend, request);
  }
}

/** Reads the leaf wire value at violation-encoded `path` under an
 * owned input value: own properties (objects) and bound indices
 * (arrays) only. Frozen parser output is safe to walk directly. */
function readWireAt(
  root: unknown,
  path: OwnedViolation["path"],
): { readonly present: boolean; readonly value?: unknown } {
  let current = root;
  for (const seg of path) {
    if ("i" in seg) {
      if (!Array.isArray(current) || seg.i >= current.length) return { present: false };
      current = current[seg.i];
    } else {
      if (typeof current !== "object" || current === null) return { present: false };
      const key = unitsToString(seg.k);
      if (!Object.hasOwn(current, key)) return { present: false };
      current = (current as Record<string, unknown>)[key];
    }
  }
  return { present: true, value: current };
}

/** Renders one JSON wire value the way the original interpreter's
 * `actualWire` does (lossy display only): quoted/truncated strings,
 * `number ` scalars, arrays by length, objects by key list. Only
 * reached for values `JSON.parse` can produce. */
function wireActual(wire: unknown): string {
  if (wire === null) return "null";
  if (typeof wire === "string") {
    return wire.length > 60 ? `${JSON.stringify(wire.slice(0, 60))}...` : (JSON.stringify(wire) as string);
  }
  if (typeof wire === "number") return `number ${String(wire)}`;
  if (typeof wire === "boolean") return wire ? "true" : "false";
  if (Array.isArray(wire)) return `array of length ${wire.length}`;
  if (typeof wire === "object") {
    return `object with keys [${Object.keys(wire).slice(0, 5).join(", ")}]`;
  }
  return typeof wire;
}

function unitsToString(units: readonly number[]): string {
  let out = "";
  for (let index = 0; index < units.length; index += 32768) {
    out += String.fromCharCode(...units.slice(index, index + 32768));
  }
  return out;
}

function violationPathToSegs(path: ReadonlyArray<string | number>): OwnedViolation["path"] {
  return path.map((step) =>
    typeof step === "number" ? { i: step } : { k: textUnits(step) },
  );
}

/** Converts one codec failure into replayable leaf-relative
 * violations: structured `SchemaError` violations keep their
 * genuine codes and messages, anything else becomes a single
 * `type` violation carrying the thrown message — recorded in the
 * outcome, never silently retried or dropped. */
type ReplayViolation = {
  readonly path: OwnedViolation["path"];
  readonly code: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
};

function replayViolations(
  error: unknown,
  prefix: OwnedViolation["path"],
): ReplayViolation[] {
  if (error instanceof SchemaError) {
    return error.violations.map((violation) => ({
      path: [...prefix, ...violationPathToSegs(violation.path)],
      code: violation.code,
      message: violation.message,
      ...(violation.expected === undefined ? {} : { expected: violation.expected }),
      ...(violation.actual === undefined ? {} : { actual: violation.actual }),
    }));
  }
  return [{ path: [...prefix], code: "type", message: error instanceof Error ? error.message : String(error) }];
}

/**
 * Runs the deferred-leaf join for one owned execution: begin once,
 * then execute; on each exact-codec deferral carrying a leaf pointer,
 * decode the leaf input at its path through the carried exact-codec
 * capability (`options.exact`, fixed before evaluation — real codec
 * calls, failures recorded, never retried or substituted), append
 * the resolved entry, and re-execute on the same request. Absent/null
 * inputs append a native-decides marker (nullability and omission
 * stay native duties). WireCodec/HostPredicate deferrals and unpointed
 * gaps pass through honestly unresolved. Each round must cover one
 * new gap (progress guard) within bounded iterations; violations of
 * either guard throw instead of looping. The request is disposed in
 * `finally`, covering success, error and cancellation.
 */
export function resolveDeferredValidation(
  backend: ValidationBackend,
  execution: OwnedExecution,
  input: unknown,
  options?: { readonly maxRounds?: number; readonly exact?: ExactCodecCapability },
): OwnedOutcome {
  const maxRounds = options?.maxRounds ?? 64;
  const codec = options?.exact ?? TS_CORE_CODEC;
  const resolved: Array<{
    path: OwnedViolation["path"];
    frame?: unknown;
    violations?: ReplayViolation[];
  }> = [];
  const seen = new Set<string>();
  const request = beginOwnedRequest(backend, execution);
  try {
    for (let round = 0; ; round += 1) {
      if (round > maxRounds) {
        throw new Error(
          "resolveDeferredValidation: bounded iterations exceeded without settling the gap.",
        );
      }
      const outcome = executeOwnedRequest(
        backend,
        request,
        execution.profile,
        execution.target,
        resolved,
      );
      if (outcome.outcome !== "deferred") return outcome;
      if (outcome.reason !== "exact-codec" || typeof outcome.leaf !== "string" || outcome.path === undefined) {
        return outcome;
      }
      const key = stableJsonStringify(outcome.path);
      if (seen.has(key)) {
        throw new Error("resolveDeferredValidation: deferred gap did not shrink between rounds.");
      }
      seen.add(key);
      const leaf = outcome.leaf;
      const at = outcome.path;
      const wantArray = typeof outcome.array === "boolean" ? outcome.array : undefined;
      const found = readWireAt(input, at);
      if (!found.present || found.value === undefined || found.value === null) {
        resolved.push({ path: at });
        continue;
      }
      // Declared-shape check before decoding (the original validateNode
      // order): scalar/array skew replays the genuine leaf verdict —
      // a whole-value decode for scalar leaves (the real codec refuses
      // arrays with its own type error), an `expected an array` type
      // violation for array leaves — instead of failing admission as
      // malformed. Pointers without a shape keep the previous dispatch.
      if (wantArray === false && Array.isArray(found.value)) {
        // The genuine carried codec refuses arrays for scalar leaves
        // with its own type error; replay it at the leaf position.
        // (Every exact scalar decoder refuses array wire, so the
        // frame path below is unreachable in practice; it stays as
        // the fail-closed carrier, never an invented verdict.)
        try {
          const canonical = codec.encode(leaf, codec.decode(leaf, found.value));
          resolved.push({ path: at, frame: frameForWireValue(canonical) });
        } catch (error) {
          resolved.push({ path: at, violations: replayViolations(error, []) });
        }
        continue;
      }
      if (wantArray === true && !Array.isArray(found.value)) {
        resolved.push({
          path: at,
          violations: [{
            path: [],
            code: "type",
            message: "expected an array",
            expected: `${leaf}[]`,
            actual: wireActual(found.value),
          }],
        });
        continue;
      }
      if (Array.isArray(found.value)) {
        const items = new Array<unknown>(found.value.length);
        const failures: ReplayViolation[] = [];
        found.value.forEach((element, index) => {
          try {
            items[index] = frameForWireValue(codec.encode(leaf, codec.decode(leaf, element)));
          } catch (error) {
            failures.push(...replayViolations(error, [{ i: index }]));
          }
        });
        if (failures.length > 0) resolved.push({ path: at, violations: failures });
        else resolved.push({ path: at, frame: { t: "array", items } });
        continue;
      }
      try {
        const canonical = codec.encode(leaf, codec.decode(leaf, found.value));
        resolved.push({ path: at, frame: frameForWireValue(canonical) });
      } catch (error) {
        resolved.push({ path: at, violations: replayViolations(error, []) });
      }
    }
  } finally {
    disposeOwnedRequest(backend, request);
  }
}

/**
 * Converts a canonical frame back to its JSON value: exact f64 bits
 * to numbers, UTF-16 units (lone surrogates preserved) to strings,
 * entries to key-ordered objects. Iterative over a heap stack, so
 * deep frames convert without host stack overflow. The inverse of
 * the owned frame join; exact `{"t":"exact","kind","value"}` nodes
 * materialize by decoding the converted wire through the carried
 * codec for that kind (`codec`, defaulting to the local cores —
 * callers with an installed selection pass it explicitly).
 * `__proto__` and every other key land as own data properties.
 */
const FRAME_JOIN: unique symbol = Symbol("frameToJsonValue.join");

export function frameToJsonValue(frame: unknown, codec: ExactCodecCapability = TS_CORE_CODEC): unknown {
  let result: unknown;
  type Cont = (value: unknown) => void;
  const stack: Array<{ node: unknown; cont: Cont }> = [
    { node: frame, cont: (value) => { result = value; } },
  ];
  const field = (node: unknown, key: string): unknown =>
    (node as Record<string, unknown>)[key];
  while (stack.length > 0) {
    const task = stack.pop() as { node: unknown; cont: Cont };
    if (task.node === FRAME_JOIN) {
      task.cont(undefined);
      continue;
    }
    const node = task.node;
    if (typeof node !== "object" || node === null) {
      throw new Error("frameToJsonValue: frame must be an object.");
    }
    const tag = field(node, "t");
    if (tag === "null") {
      task.cont(null);
      continue;
    }
    if (tag === "bool") {
      task.cont(field(node, "v") === true);
      continue;
    }
    if (tag === "f64") {
      const bits = field(node, "bits");
      if (typeof bits !== "string" || bits.length !== 16) {
        throw new Error("frameToJsonValue: f64 bits must be 16 hex digits.");
      }
      const view = new DataView(new ArrayBuffer(8));
      for (let index = 0; index < 8; index++) {
        view.setUint8(index, Number.parseInt(bits.slice(index * 2, index * 2 + 2), 16));
      }
      task.cont(view.getFloat64(0));
      continue;
    }
    if (tag === "text") {
      const units = field(node, "units");
      if (!Array.isArray(units)) throw new Error("frameToJsonValue: text units must be an array.");
      task.cont(unitsToString(units as number[]));
      continue;
    }
    if (tag === "array") {
      const items = field(node, "items");
      if (!Array.isArray(items)) throw new Error("frameToJsonValue: array items must be an array.");
      const out = new Array<unknown>(items.length);
      // Join marker runs after all descendants (pushed first, popped last).
      stack.push({ node: FRAME_JOIN, cont: () => task.cont(out) });
      for (let index = items.length - 1; index >= 0; index--) {
        const at = index;
        stack.push({ node: items[at], cont: (value) => { out[at] = value; } });
      }
      continue;
    }
    if (tag === "entries") {
      const entries = field(node, "entries");
      if (!Array.isArray(entries)) throw new Error("frameToJsonValue: entries must be an array.");
      // Lossless own-property materialization: plain assignment would
      // route an own `__proto__` key through the prototype setter and
      // lose the declaration, so every key (including `__proto__`)
      // lands as an own data property.
      const out: Record<string, unknown> = {};
      stack.push({ node: FRAME_JOIN, cont: () => task.cont(out) });
      for (let index = entries.length - 1; index >= 0; index--) {
        const pair: unknown = entries[index];
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new Error("frameToJsonValue: entries must be key/value pairs.");
        }
        const key = unitsToString(pair[0] as number[]);
        stack.push({ node: pair[1], cont: (value) => {
          Object.defineProperty(out, key, {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        } });
      }
      continue;
    }
    if (tag === "exact") {
      const kind = field(node, "kind");
      const value = field(node, "value");
      if (typeof kind !== "string") throw new Error("frameToJsonValue: exact kind must be text.");
      stack.push({
        node: value,
        cont: (wire) => {
          task.cont(codec.decode(kind, wire));
        },
      });
      continue;
    }
    throw new Error("frameToJsonValue: unknown frame tag.");
  }
  return result;
}

/**
 * Scaffold backend over caller-supplied glue. The ABI version is
 * checked at construction: a mismatched module fails here, never
 * mid-request.
 */
function quoteJsonString(text: string): string {
  let out = '"';
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit === 0x22) out += '\\"';
    else if (unit === 0x5c) out += "\\\\";
    else if (unit === 0x08) out += "\\b";
    else if (unit === 0x09) out += "\\t";
    else if (unit === 0x0a) out += "\\n";
    else if (unit === 0x0c) out += "\\f";
    else if (unit === 0x0d) out += "\\r";
    else if (unit < 0x20) out += "\\u" + unit.toString(16).padStart(4, "0");
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      const high = text[index] as string;
      const low = index + 1 < text.length ? (text[index + 1] as string) : "";
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Valid pair passes raw, exactly like JSON.stringify.
        out += high + low;
        index++;
      } else {
        out += "\\u" + unit.toString(16).padStart(4, "0");
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += "\\u" + unit.toString(16).padStart(4, "0");
    } else out += text[index];
  }
  return out + '"';
}

/** Iterative `JSON.stringify` for JSON-shaped request data. Byte-identical
 * to `JSON.stringify` for null/boolean/finite numbers/strings/arrays/plain
 * objects (same key order, same escapes, same `-0`→`0` and
 * non-finite→`null` coercions, same `TypeError` on bigint), but recursion
 * free: deep frames that `JSON.stringify` would overflow serialize on the
 * heap instead. No depth limit is imposed here; native budgets decide.
 * Cyclic structures throw `TypeError` instead of hanging. `toJSON`
 * methods are out of contract (request data never defines them). */
const JOIN_MARKER: unique symbol = Symbol("stableJson.join");

export function stableJsonStringify(root: unknown): string {
  let result = "";
  const ancestors = new Set<object>();
  type Cont = (text: string) => void;
  const stack: Array<{ value: unknown; cont: Cont }> = [
    {
      value: root,
      cont: (text) => {
        result = text;
      },
    },
  ];
  while (stack.length > 0) {
    const task = stack.pop() as { value: unknown; cont: Cont };
    const value = task.value;
    if (value === JOIN_MARKER) {
      task.cont("");
      continue;
    }
    if (value === null) {
      task.cont("null");
      continue;
    }
    if (typeof value === "boolean") {
      task.cont(value ? "true" : "false");
      continue;
    }
    if (typeof value === "number") {
      task.cont(Number.isFinite(value) ? String(value) : "null");
      continue;
    }
    if (typeof value === "string") {
      task.cont(quoteJsonString(value));
      continue;
    }
    if (typeof value === "bigint") {
      throw new TypeError("Do not know how to serialize a BigInt");
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
      ancestors.add(value);
      const parts = new Array<string>(value.length);
      // Join marker runs after all descendants (pushed later, popped first).
      stack.push({
        value: JOIN_MARKER,
        cont: () => {
          task.cont("[" + parts.join(",") + "]");
          ancestors.delete(value);
        },
      });
      for (let index = value.length - 1; index >= 0; index--) {
        const at = index;
        const item: unknown = value[at];
        stack.push({
          value: item === undefined ? null : item,
          cont: (text) => {
            parts[at] = text;
          },
        });
      }
      continue;
    }
    if (typeof value === "object") {
      if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
      ancestors.add(value);
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter(
        (key) =>
          record[key] !== undefined &&
          typeof record[key] !== "function" &&
          typeof record[key] !== "symbol",
      );
      const parts = new Array<string>(keys.length);
      stack.push({
        value: JOIN_MARKER,
        cont: () => {
          task.cont("{" + parts.join(",") + "}");
          ancestors.delete(value);
        },
      });
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        if (key === undefined) continue; // Unreachable: index < length.
        const at = index;
        stack.push({
          value: record[key] as unknown,
          cont: (text) => {
            parts[at] = quoteJsonString(key) + ":" + text;
          },
        });
      }
      continue;
    }
    throw new TypeError("stableJsonStringify requires JSON-shaped data");
  }
  return result;
}

export function validationBackend(glue: ValidationGlue): ValidationBackend {
  const abi = glue.structural_abi_version();
  if (abi !== REQUIRED_STRUCTURAL_ABI) {
    throw new StructuralError("transport", "version/unsupported");
  }
  return {
    call(op: string, args: Record<string, unknown>): unknown {
      const request = stableJsonStringify({ v: REQUIRED_STRUCTURAL_ABI, op, args });
      const response = JSON.parse(glue.validation_call(request)) as {
        ok: boolean;
        value?: unknown;
        stage?: StructuralStage;
        code?: string;
        check?: string;
      };
      if (!response.ok) {
        throw new StructuralError(
          response.stage ?? "transport",
          response.code ?? "args/malformed",
          response.check,
        );
      }
      return response.value;
    },
  };
}
