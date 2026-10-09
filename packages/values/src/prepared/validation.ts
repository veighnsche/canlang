/**
 * V02.2 prepared validation + whole-call comparator (TS side).
 *
 * `validatePreparedValue` binds a call to a live V02.1 owner plan — issued
 * owner, live plan, caller schema structurally cross-checked against the
 * plan's frozen copies, type-id coverage — then delegates the evaluation to
 * the canonical non-dispatching TS core. This explicit preparation gate
 * is not production owner/request admission. Like the MCP precedent, the
 * prepared layer reorders nothing and re-derives nothing: behavior stays
 * legacy, and the comparator below proves it call by call.
 *
 * The comparator runs the direct legacy call and the prepared call over the
 * same arguments and compares whole-call outcomes: ok values with
 * getter-safe structural equality, thrown errors via getter-safe digests
 * (name/kind/code/message/violations — stacks excluded, they carry
 * run-specific paths). When the prepared side abstains with `PlanError`
 * (foreign owner, released plan, schema/plan mismatch, uncovered type),
 * the comparison records `preparedAbstained` instead of agreement: the
 * legacy outcome stands as the full-scope result.
 *
 * Getter discipline: snapshots and equality walk `Object.getOwnProperty-
 * Descriptors` and NEVER invoke accessors — an accessor records as a
 * `{ $getter: true }` marker (snapshots) or compares by getter/setter
 * identity (equality). Comparator machinery therefore adds zero getter
 * invocations beyond the two delegated legacy runs. Cycle-safe via
 * visited sets (termination, not a V07 budget).
 */
import type { CanValue } from "@canlang/contracts/values";
import type { NormalizedSchema, UpdateContract, ValidationMode } from "../schema.js";
import { validateValue } from "../schema.js";
import { validateValueTsCore } from "../internal/schema-core.js";
import { decodeValue, encodeValue } from "../wire.js";
import type { NormalizedType } from "../types.js";
import { printTypeId } from "../types.js";
import { decodePreparedValue, encodePreparedValue, isPlanCoveredType } from "./codec.js";
import type {
  DefaultRef,
  PreparedContractPlan,
  PreparedFieldPlan,
  PreparedOperationPlan,
  PreparedValidationPlan,
} from "./plan.js";
import { getValidationPlan, PlanError, resolvePlanDefault } from "./plan.js";

// ---------------------------------------------------------------------------
// Getter-safe structural equality (never invokes accessors).
// ---------------------------------------------------------------------------

function isObjectLike(value: unknown): value is Record<string | symbol, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/**
 * Structural equality that never invokes getters: data descriptors recurse,
 * accessor descriptors compare by getter/setter identity, prototypes must
 * match, own-key order is significant. Cycles resolve by visited pair.
 */
export function traceEqual(a: unknown, b: unknown, seen?: WeakMap<object, WeakSet<object>>): boolean {
  if (Object.is(a, b)) return true;
  // Distinct functions are never structurally equal (identity only).
  if (typeof a === "function" || typeof b === "function") return false;
  if (!isObjectLike(a) || !isObjectLike(b)) return false;
  const pairs = seen ?? new WeakMap<object, WeakSet<object>>();
  let inner = pairs.get(a);
  if (inner !== undefined && inner.has(b)) return true;
  if (inner === undefined) {
    inner = new WeakSet<object>();
    pairs.set(a, inner);
  }
  inner.add(b);
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const aKeys = Reflect.ownKeys(a);
  const bKeys = Reflect.ownKeys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (!Object.is(aKeys[i], bKeys[i])) return false;
  }
  for (const key of aKeys) {
    const aDesc = Object.getOwnPropertyDescriptor(a, key);
    const bDesc = Object.getOwnPropertyDescriptor(b, key);
    if (aDesc === undefined || bDesc === undefined) return false;
    const aAccess = typeof aDesc.get === "function" || typeof aDesc.set === "function";
    const bAccess = typeof bDesc.get === "function" || typeof bDesc.set === "function";
    if (aAccess || bAccess) {
      if (!aAccess || !bAccess) return false;
      if (!Object.is(aDesc.get, bDesc.get) || !Object.is(aDesc.set, bDesc.set)) return false;
      continue;
    }
    if (!traceEqual(aDesc.value, bDesc.value, pairs)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Getter-safe JSON-able snapshots for comparison traces.
// ---------------------------------------------------------------------------

/** JSON-able trace snapshot. Markers (`$`-prefixed) are compared structurally, never decoded. */
export type TraceSnapshot = unknown;

function defineSnapshotKey(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function snapshotDataDescriptor(value: unknown, seen: WeakSet<object>): TraceSnapshot {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $number: "NaN" };
    if (value === Number.POSITIVE_INFINITY) return { $number: "+Infinity" };
    if (value === Number.NEGATIVE_INFINITY) return { $number: "-Infinity" };
    return value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "symbol") return { $symbol: value.description ?? null };
  if (typeof value === "undefined") return { $undefined: true };
  if (typeof value === "function") return { $function: value.name === "" ? null : value.name };
  if (typeof value !== "object") return { $typeof: typeof value };
  if (seen.has(value)) return { $cycle: true };
  seen.add(value);
  if (Array.isArray(value)) return snapshotArray(value, seen);
  const proto = Object.getPrototypeOf(value);
  const plain = proto === Object.prototype || proto === null;
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined) continue;
    const label = typeof key === "symbol" ? `$symbolKey:${key.description ?? ""}` : key;
    if (typeof desc.get === "function" || typeof desc.set === "function") {
      defineSnapshotKey(out, label, {
        $getter: true,
        setter: typeof desc.set === "function",
      });
    } else {
      defineSnapshotKey(out, label, snapshotDataDescriptor(desc.value, seen));
    }
  }
  if (plain) return out;
  const ctor = (proto as { constructor?: { name?: unknown } } | null)?.constructor;
  const name = typeof ctor?.name === "string" && ctor.name !== "" ? ctor.name : null;
  return { $instance: name, props: out };
}

function isArrayIndexKey(value: readonly unknown[], key: string | symbol): boolean {
  if (typeof key !== "string") return false;
  if (key === "length") return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key;
}

/**
 * Snapshot an array as an array (element order preserved). Non-index own
 * keys (custom props, symbols) ride in a `$extra` marker so exotic arrays
 * lose nothing; ordinary arrays snapshot bare.
 */
function snapshotArray(value: readonly unknown[], seen: WeakSet<object>): TraceSnapshot {
  const elements = value.map((element) => snapshotDataDescriptor(element, seen));
  const extraKeys = Reflect.ownKeys(value).filter(
    (key) => key !== "length" && !isArrayIndexKey(value, key),
  );
  if (extraKeys.length === 0) return elements;
  const extra: Record<string, unknown> = {};
  for (const key of extraKeys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined) continue;
    const label = typeof key === "symbol" ? `$symbolKey:${key.description ?? ""}` : key;
    if (typeof desc.get === "function" || typeof desc.set === "function") {
      defineSnapshotKey(extra, label, { $getter: true, setter: typeof desc.set === "function" });
    } else {
      defineSnapshotKey(extra, label, snapshotDataDescriptor(desc.value, seen));
    }
  }
  return { $array: elements, $extra: extra };
}

/** Snapshot any value without invoking accessors. Never throws on data. */
export function snapshotTrace(value: unknown): TraceSnapshot {
  return snapshotDataDescriptor(value, new WeakSet<object>());
}

// ---------------------------------------------------------------------------
// Thrown-error digests (getter-safe reads; stacks excluded).
// ---------------------------------------------------------------------------

/** Whole-call error digest: identity + message + structured violations. No stack. */
export interface ErrorDigest {
  readonly name: string;
  readonly kind?: string;
  readonly code?: string;
  readonly message: string;
  readonly violations?: TraceSnapshot;
}

function dataProp(value: object, key: string): unknown {
  const desc = Object.getOwnPropertyDescriptor(value, key);
  if (desc === undefined) return undefined;
  if (typeof desc.get === "function" || typeof desc.set === "function") return undefined;
  return desc.value;
}

/** Digest a thrown value without invoking accessors. Never throws. */
export function digestThrown(thrown: unknown): ErrorDigest {
  if (!isObjectLike(thrown)) {
    return { name: typeof thrown, message: "non-object thrown" };
  }
  const nameProp = dataProp(thrown, "name");
  const ctor = (thrown as { constructor?: { name?: unknown } }).constructor;
  const name =
    typeof nameProp === "string"
      ? nameProp
      : typeof ctor?.name === "string" && ctor.name !== ""
        ? ctor.name
        : typeof thrown;
  const messageProp = dataProp(thrown, "message");
  const message = typeof messageProp === "string" ? messageProp : "<unreadable message>";
  const digest: Record<string, unknown> = { name, message };
  const kind = dataProp(thrown, "kind");
  if (typeof kind === "string") digest["kind"] = kind;
  const code = dataProp(thrown, "code");
  if (typeof code === "string") digest["code"] = code;
  const violations = dataProp(thrown, "violations");
  if (violations !== undefined) digest["violations"] = snapshotTrace(violations);
  return digest as unknown as ErrorDigest;
}

// ---------------------------------------------------------------------------
// Schema<->plan structural cross-check.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function fieldMatches(
  owner: unknown,
  planField: PreparedFieldPlan,
  schemaField: Record<string, unknown>,
  where: string,
): void {
  const mismatch = (detail: string): PlanError =>
    new PlanError("unknown-plan", `validatePreparedValue abstains: schema/plan mismatch at ${where} (${detail})`);
  if (["format", "distinctBy", "excludedIds"].some(key => Object.hasOwn(schemaField, key))) throw mismatch("unsupported field constraints");
  if (schemaField["typeId"] !== planField.typeId) throw mismatch("typeId");
  if (schemaField["required"] !== planField.required) throw mismatch("required");
  if (schemaField["hasDefault"] !== planField.hasDefault) throw mismatch("hasDefault");
  if (schemaField["serverOnly"] !== planField.serverOnly) throw mismatch("serverOnly");
  if ((schemaField["lengthMin"] ?? undefined) !== (planField.lengthMin ?? undefined)) {
    throw mismatch("lengthMin");
  }
  if ((schemaField["lengthMax"] ?? undefined) !== (planField.lengthMax ?? undefined)) {
    throw mismatch("lengthMax");
  }
  if ((schemaField["trim"] ?? undefined) !== (planField.trim ?? undefined)) throw mismatch("trim");
  if ((schemaField["defaultOrigin"] ?? undefined) !== (planField.defaultOrigin ?? undefined)) {
    throw mismatch("defaultOrigin");
  }
  const schemaType = schemaField["type"];
  if (!isRecord(schemaType)) throw mismatch("type shape");
  let sameAst = false;
  try {
    sameAst = printTypeId(planField.type) === printTypeId(schemaType as unknown as NormalizedType);
  } catch {
    sameAst = false;
  }
  if (!sameAst) throw mismatch("type AST");
  const minDefined = schemaField["valueMin"] !== undefined;
  const planMinDefined = planField.valueMin !== undefined;
  if (minDefined !== planMinDefined) throw mismatch("valueMin presence");
  if (
    minDefined &&
    planMinDefined &&
    !traceEqual(schemaField["valueMin"], planField.valueMin)
  ) {
    throw mismatch("valueMin");
  }
  const maxDefined = schemaField["valueMax"] !== undefined;
  const planMaxDefined = planField.valueMax !== undefined;
  if (maxDefined !== planMaxDefined) throw mismatch("valueMax presence");
  if (
    maxDefined &&
    planMaxDefined &&
    !traceEqual(schemaField["valueMax"], planField.valueMax)
  ) {
    throw mismatch("valueMax");
  }
  if (planField.hasDefault) {
    const ref: DefaultRef | undefined = planField.defaultRef;
    const schemaDefault = schemaField["default"];
    if (ref === undefined || schemaDefault === undefined) throw mismatch("default presence");
    const registered = resolvePlanDefault(owner, ref);
    if (!traceEqual(schemaDefault, registered)) throw mismatch("default value");
  }
}

function contractMatches(
  owner: unknown,
  planContract: PreparedContractPlan,
  schemaContract: Record<string, unknown>,
  where: string,
): void {
  const fields = schemaContract["fields"];
  if (!isRecord(fields)) {
    throw new PlanError("unknown-plan", `validatePreparedValue abstains: schema/plan mismatch at ${where} (fields shape)`);
  }
  const names = Object.keys(fields);
  if (!sameStringList(names, planContract.allowed)) {
    throw new PlanError(
      "unknown-plan",
      `validatePreparedValue abstains: schema/plan mismatch at ${where} (field order)`,
    );
  }
  const required = names.filter((name) => (fields[name] as Record<string, unknown>)["required"] === true);
  if (!sameStringList(required, planContract.required)) {
    throw new PlanError(
      "unknown-plan",
      `validatePreparedValue abstains: schema/plan mismatch at ${where} (required order)`,
    );
  }
  for (let i = 0; i < planContract.fields.length; i++) {
    const planField = planContract.fields[i] as PreparedFieldPlan;
    const schemaField = fields[planField.name];
    if (!isRecord(schemaField)) {
      throw new PlanError(
        "unknown-plan",
        `validatePreparedValue abstains: schema/plan mismatch at ${where} (field ${planField.name} shape)`,
      );
    }
    fieldMatches(owner, planField, schemaField, `${where}.${planField.name}`);
  }
}

function operationMatches(
  owner: unknown,
  planOp: PreparedOperationPlan,
  schemaOp: Record<string, unknown>,
  where: string,
): void {
  if (schemaOp["mutation"] !== planOp.mutation) {
    throw new PlanError("unknown-plan", `validatePreparedValue abstains: schema/plan mismatch at ${where} (mutation)`);
  }
  const inputs = schemaOp["inputs"];
  if (!isRecord(inputs)) {
    throw new PlanError("unknown-plan", `validatePreparedValue abstains: schema/plan mismatch at ${where} (inputs shape)`);
  }
  const names = Object.keys(inputs);
  if (!sameStringList(names, planOp.allowed)) {
    throw new PlanError(
      "unknown-plan",
      `validatePreparedValue abstains: schema/plan mismatch at ${where} (input order)`,
    );
  }
  const required = names.filter((name) => (inputs[name] as Record<string, unknown>)["required"] === true);
  if (!sameStringList(required, planOp.required)) {
    throw new PlanError(
      "unknown-plan",
      `validatePreparedValue abstains: schema/plan mismatch at ${where} (required order)`,
    );
  }
  for (let i = 0; i < planOp.inputs.length; i++) {
    const planField = planOp.inputs[i] as PreparedFieldPlan;
    const schemaField = inputs[planField.name];
    if (!isRecord(schemaField)) {
      throw new PlanError(
        "unknown-plan",
        `validatePreparedValue abstains: schema/plan mismatch at ${where} (input ${planField.name} shape)`,
      );
    }
    fieldMatches(owner, planField, schemaField, `${where}.${planField.name}`);
  }
}

/**
 * Fail closed unless the caller's schema is structurally the schema the
 * plan was copied from: names, descriptor order, type ASTs (canonical
 * spelling), flags, bounds, and registry defaults. A mismatched schema —
 * mutated after registration or simply a different schema — abstains with
 * `PlanError` and stays on legacy `validateValue`.
 */
function crossCheckSchema(owner: unknown, plan: PreparedValidationPlan, schema: NormalizedSchema): void {
  const mismatch = (detail: string): PlanError =>
    new PlanError("unknown-plan", `validatePreparedValue abstains: schema/plan mismatch (${detail})`);
  if (!isRecord(schema.contracts) || !isRecord(schema.enums) || !isRecord(schema.operations)) {
    throw mismatch("section shape");
  }
  if (Object.hasOwn(schema, "aliases")) throw mismatch("unsupported aliases");
  const contracts = schema.contracts as Record<string, unknown>;
  const enums = schema.enums as Record<string, unknown>;
  const operations = schema.operations as Record<string, unknown>;
  if (!sameStringList(Object.keys(contracts), plan.contractOrder)) throw mismatch("contract order");
  if (!sameStringList(Object.keys(enums), plan.enumOrder)) throw mismatch("enum order");
  if (!sameStringList(Object.keys(operations), plan.operationOrder)) throw mismatch("operation order");
  for (const name of plan.contractOrder) {
    const schemaContract = contracts[name];
    if (!isRecord(schemaContract)) throw mismatch(`contract ${name} shape`);
    contractMatches(owner, plan.contracts[name] as PreparedContractPlan, schemaContract, `contracts.${name}`);
  }
  for (const name of plan.enumOrder) {
    const schemaEnum = enums[name] as { cases?: unknown };
    const planEnum = plan.enums[name];
    if (!isRecord(schemaEnum) || !Array.isArray(schemaEnum["cases"]) || planEnum === undefined) {
      throw mismatch(`enum ${name} shape`);
    }
    const cases = schemaEnum["cases"] as unknown[];
    if (!sameStringList(cases as string[], planEnum.cases)) throw mismatch(`enum ${name} cases`);
  }
  for (const name of plan.operationOrder) {
    const schemaOp = operations[name];
    if (!isRecord(schemaOp)) throw mismatch(`operation ${name} shape`);
    operationMatches(owner, plan.operations[name] as PreparedOperationPlan, schemaOp, `operations.${name}`);
  }
}

// ---------------------------------------------------------------------------
// Prepared validation entry point.
// ---------------------------------------------------------------------------

/**
 * Validate wire data under a live plan: owner + plan admission, caller
 * schema cross-checked against the plan's frozen copies, type-id coverage,
 * then the canonical legacy `validateValue`. Admission failures throw
 * `PlanError` (caller stays on legacy); validation failures throw the
 * legacy `SchemaError`/`ValueError` verbatim.
 */
export function validatePreparedValue(
  owner: unknown,
  id: unknown,
  schema: NormalizedSchema,
  typeId: string,
  wire: unknown,
  mode: ValidationMode,
): CanValue | UpdateContract {
  const plan = getValidationPlan(owner, id);
  if (!isRecord(schema) || schema["kind"] !== "normalized-schema") {
    throw new PlanError("unknown-plan", "validatePreparedValue abstains: schema fails the normalized shape gate");
  }
  crossCheckSchema(owner, plan, schema as NormalizedSchema);
  if (typeof typeId !== "string" || !isPlanCoveredType(plan, typeId)) {
    throw new PlanError(
      "unknown-plan",
      `validatePreparedValue abstains: type ${JSON.stringify(typeId)} is not covered by this plan (legacy keeps full scope)`,
    );
  }
  // The overload cast is compile-time only: the runtime mode string reaches
  // legacy verbatim (including caller-misuse modes, which keep the canonical
  // legacy ValueError).
  return validateValueTsCore(schema as NormalizedSchema, typeId, wire, mode as "create");
}

// ---------------------------------------------------------------------------
// Whole-call comparator.
// ---------------------------------------------------------------------------

/** One recorded whole-call outcome: ok snapshot or thrown-error digest. */
export type CallOutcomeTrace =
  | { readonly ok: true; readonly snapshot: TraceSnapshot }
  | { readonly ok: false; readonly error: ErrorDigest };

export interface ValidateCallRequest {
  readonly owner: unknown;
  readonly planId: unknown;
  readonly schema: NormalizedSchema;
  readonly typeId: string;
  readonly wire: unknown;
  readonly mode: ValidationMode;
}

export interface CodecCallRequest {
  readonly owner: unknown;
  readonly planId: unknown;
  readonly direction: "encode" | "decode";
  readonly typeId: string;
  readonly value: unknown;
}

/**
 * Whole-call comparison record. `agree` is true exactly when both sides
 * ran and their whole-call outcomes are structurally identical. When the
 * prepared side abstains (`PlanError`), `preparedAbstained` is true, `agree`
 * is false, and the legacy trace stands as the full-scope result.
 */
export interface CallComparison {
  readonly kind: "validate" | "encode" | "decode";
  readonly agree: boolean;
  readonly preparedAbstained: boolean;
  readonly input: TraceSnapshot;
  readonly legacy: CallOutcomeTrace;
  readonly prepared: CallOutcomeTrace | { readonly abstained: true; readonly error: ErrorDigest };
}

interface LiveOutcome {
  readonly trace: CallOutcomeTrace;
  readonly value: unknown;
  readonly abstained: boolean;
}

function runLegacyValidate(req: ValidateCallRequest): LiveOutcome {
  try {
    // Overload cast is compile-time only; the runtime mode reaches legacy verbatim.
    const value = validateValue(req.schema, req.typeId, req.wire, req.mode as "create");
    return { trace: { ok: true, snapshot: snapshotTrace(value) }, value, abstained: false };
  } catch (thrown) {
    return { trace: { ok: false, error: digestThrown(thrown) }, value: undefined, abstained: false };
  }
}

function runPreparedValidate(req: ValidateCallRequest): LiveOutcome {
  try {
    const value = validatePreparedValue(req.owner, req.planId, req.schema, req.typeId, req.wire, req.mode);
    return { trace: { ok: true, snapshot: snapshotTrace(value) }, value, abstained: false };
  } catch (thrown) {
    if (thrown instanceof PlanError) {
      return { trace: { ok: false, error: digestThrown(thrown) }, value: undefined, abstained: true };
    }
    return { trace: { ok: false, error: digestThrown(thrown) }, value: undefined, abstained: false };
  }
}

function runLegacyCodec(req: CodecCallRequest): LiveOutcome {
  try {
    const value =
      req.direction === "encode"
        ? encodeValue(req.typeId, req.value as CanValue)
        : decodeValue(req.typeId, req.value);
    return { trace: { ok: true, snapshot: snapshotTrace(value) }, value, abstained: false };
  } catch (thrown) {
    return { trace: { ok: false, error: digestThrown(thrown) }, value: undefined, abstained: false };
  }
}

function runPreparedCodec(req: CodecCallRequest): LiveOutcome {
  try {
    const value =
      req.direction === "encode"
        ? encodePreparedValue(req.owner, req.planId, req.typeId, req.value as CanValue)
        : decodePreparedValue(req.owner, req.planId, req.typeId, req.value);
    return { trace: { ok: true, snapshot: snapshotTrace(value) }, value, abstained: false };
  } catch (thrown) {
    if (thrown instanceof PlanError) {
      return { trace: { ok: false, error: digestThrown(thrown) }, value: undefined, abstained: true };
    }
    return { trace: { ok: false, error: digestThrown(thrown) }, value: undefined, abstained: false };
  }
}

function compareLiveOutcomes(legacy: LiveOutcome, prepared: LiveOutcome): boolean {
  if (prepared.abstained) return false;
  if (legacy.trace.ok && prepared.trace.ok) {
    return traceEqual(legacy.value, prepared.value);
  }
  if (!legacy.trace.ok && !prepared.trace.ok) {
    return traceEqual(legacy.trace.error, prepared.trace.error);
  }
  return false;
}

function toComparison(
  kind: CallComparison["kind"],
  input: TraceSnapshot,
  legacy: LiveOutcome,
  prepared: LiveOutcome,
): CallComparison {
  const preparedTrace: CallComparison["prepared"] = prepared.abstained
    ? { abstained: true, error: (prepared.trace as { error: ErrorDigest }).error }
    : prepared.trace;
  return {
    kind,
    agree: compareLiveOutcomes(legacy, prepared),
    preparedAbstained: prepared.abstained,
    input,
    legacy: legacy.trace,
    prepared: preparedTrace,
  };
}

/**
 * Compare one whole validation call: direct legacy `validateValue` versus
 * plan-bound `validatePreparedValue` over the same arguments. Input is
 * snapshotted getter-safely before either run; neither snapshot invokes
 * accessors.
 */
export function compareValidationCall(req: ValidateCallRequest): CallComparison {
  const input = snapshotTrace(req.wire);
  const legacy = runLegacyValidate(req);
  const prepared = runPreparedValidate(req);
  return toComparison("validate", input, legacy, prepared);
}

/**
 * Compare one whole codec call: direct legacy `encodeValue`/`decodeValue`
 * versus the plan-gated prepared codec over the same arguments.
 */
export function compareCodecCall(req: CodecCallRequest): CallComparison {
  const input = snapshotTrace(req.value);
  const legacy = runLegacyCodec(req);
  const prepared = runPreparedCodec(req);
  return toComparison(req.direction, input, legacy, prepared);
}
