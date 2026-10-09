/**
 * V02.1 immutable owner validation plans (TS side).
 *
 * Genuine factory owners register ordered type/union/leaf plans extracted
 * from factory-produced normalized schemas. Registration deep-copies every
 * metadata value, so post-registration mutation of the descriptor, the
 * normalized schema, or any caller-held object cannot modify the plan.
 * Defaults resolve through the plan owner's shared frozen default registry
 * with stable identity (repeated resolution returns the same object).
 *
 * Provenance, not shape, admits a schema: only a normalized schema recorded
 * by the private factory hook (see the V02.6 hook specification in
 * `prepared-plan-handoff.md`) may register. Forged `kind` tags, frozen
 * hand-built schemas (freeze establishes nothing), unknown string wrappers,
 * and structurally accepted legacy schemas are rejected here and stay on
 * the legacy `validateValue` path, which this module never touches.
 *
 * All behavior is synchronous. Plan IDs are issuer-assigned sequence tags
 * carrying ABI/profile version, backend instance, generation, and owner
 * revision; no caller-controlled string sizes any cache. Numeric plan
 * budgets are NOT fixed here (current-ts.json records them as hypotheses
 * for V03 to measure and V07 to fix).
 */
import type {
  CanValue,
  FieldDefaultOrigin,
} from "@canlang/contracts/values";
import type {
  NormalizedField,
  NormalizedSchema,
} from "../schema.js";
import type { NormalizedType } from "../types.js";

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/** Machine-readable plan-registry failure codes. */
export type PlanErrorCode =
  | "foreign-owner"
  | "invalid-profile"
  | "legacy-wrapper"
  | "missing-provenance"
  | "stale-scope"
  | "malformed-schema"
  | "unknown-plan"
  | "unknown-default"
  | "uncopyable-value";

/** Registration/resolution failure. Never thrown for legacy validation. */
export class PlanError extends Error {
  readonly code: PlanErrorCode;
  constructor(code: PlanErrorCode, message: string) {
    super(`validation plan: ${message}`);
    this.name = "PlanError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Owner scope and tokens.
// ---------------------------------------------------------------------------

/** Artifact/owner scope a plan registry is bound to. Copied at creation. */
export interface OwnerScope {
  readonly abiVersion: string;
  readonly profileVersion: string;
  readonly backendId: string;
  readonly ownerRevision: string;
}

/**
 * Unforgeable owner token. Only `createPlanOwner` mints tokens; possession
 * proves issuance because membership is checked against a module-private
 * registry, never against object shape.
 */
export interface PlanOwner {
  readonly scope: OwnerScope;
}

interface OwnerState {
  readonly scope: OwnerScope;
  readonly generation: number;
  nextSequence: number;
  readonly plans: Map<number, PreparedValidationPlan>;
  /** Shared frozen default registry: key -> identical frozen value. */
  readonly defaults: Map<string, CanValue>;
}

const ISSUED_OWNERS = new WeakSet<object>();
const OWNER_STATE = new WeakMap<object, OwnerState>();

function ownerStateOf(owner: unknown, what: string): OwnerState {
  if (typeof owner !== "object" || owner === null || !ISSUED_OWNERS.has(owner)) {
    throw new PlanError("foreign-owner", `${what} requires a plan owner issued by createPlanOwner`);
  }
  const state = OWNER_STATE.get(owner);
  if (state === undefined) {
    throw new PlanError("foreign-owner", `${what} requires a plan owner issued by createPlanOwner`);
  }
  return state;
}

/** Mint one owner registry bound to a copied, frozen scope. Synchronous. */
export function createPlanOwner(scope: OwnerScope): PlanOwner {
  if (typeof scope !== "object" || scope === null) {
    throw new PlanError("foreign-owner", "owner scope must be an object");
  }
  for (const key of ["abiVersion", "profileVersion", "backendId", "ownerRevision"] as const) {
    if (typeof scope[key] !== "string" || scope[key].length === 0) {
      throw new PlanError("foreign-owner", `owner scope ${key} must be a non-empty string`);
    }
  }
  const frozenScope = Object.freeze({
    abiVersion: scope.abiVersion,
    profileVersion: scope.profileVersion,
    backendId: scope.backendId,
    ownerRevision: scope.ownerRevision,
  });
  const owner = { scope: frozenScope } as PlanOwner;
  const state: OwnerState = {
    scope: frozenScope,
    generation: 0,
    nextSequence: 0,
    plans: new Map(),
    defaults: new Map(),
  };
  ISSUED_OWNERS.add(owner);
  OWNER_STATE.set(owner, state);
  return Object.freeze(owner);
}

// ---------------------------------------------------------------------------
// Factory provenance (V02.6 hook surface; integrator-private).
// ---------------------------------------------------------------------------

interface FactoryProvenance {
  readonly factory: "normalizeSchema";
  readonly ownerRevision: string;
}

const FACTORY_PROVENANCE = new WeakMap<object, FactoryProvenance>();

/**
 * Record factory provenance for a newly constructed normalized schema.
 *
 * INTEGRATOR-PRIVATE: only the V02.6 factory hook inside `normalizeSchema`
 * may call this (see `prepared-plan-handoff.md` for the patch
 * specification). Tests call it directly to stand in for the genuine
 * factory path until V02.6 lands. Calling it on any other object is a
 * programming error, not a caller input: it throws rather than record.
 */
export function recordFactoryProvenance(schema: object, ownerRevision: string): void {
  if (typeof schema !== "object" || schema === null) {
    throw new PlanError("malformed-schema", "factory provenance requires a schema object");
  }
  if (typeof ownerRevision !== "string" || ownerRevision.length === 0) {
    throw new PlanError("malformed-schema", "factory provenance requires a non-empty owner revision");
  }
  const candidate = schema as { readonly kind?: unknown };
  if (candidate.kind !== "normalized-schema") {
    throw new PlanError("malformed-schema", "factory provenance requires a normalized schema output");
  }
  FACTORY_PROVENANCE.set(schema, { factory: "normalizeSchema", ownerRevision });
}

function provenanceOf(schema: object): FactoryProvenance | undefined {
  return FACTORY_PROVENANCE.get(schema);
}

// ---------------------------------------------------------------------------
// Immutable copies.
// ---------------------------------------------------------------------------

/**
 * Deep-copy a plan metadata value and freeze the copy. Plain data only
 * (primitives, bigint, arrays, plain objects); symbols pass through by
 * identity; anything else (class instances, Maps, functions-as-values)
 * fails closed — a plan must never alias caller-owned exotic state.
 * `__proto__` keys are defined, never assigned.
 */
function copyFrozenValue(value: unknown): CanValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    value === undefined
  ) {
    return value as CanValue;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = value.map(copyFrozenValue);
    return Object.freeze(out) as unknown as CanValue;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new PlanError("uncopyable-value", "plan metadata must be plain data (no class instances)");
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: copyFrozenValue((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return Object.freeze(out) as unknown as CanValue;
  }
  throw new PlanError("uncopyable-value", `plan metadata cannot hold ${typeof value} values`);
}

function copyFrozenType(type: NormalizedType): NormalizedType {
  const base = type.base;
  let copiedBase: NormalizedType["base"];
  switch (base.kind) {
    case "scalar":
      copiedBase = { kind: "scalar", name: base.name };
      break;
    case "stringlike":
      copiedBase = { kind: "stringlike", name: base.name };
      break;
    case "user":
    case "member":
    case "file":
    case "secret":
    case "json":
      copiedBase = { kind: base.kind };
      break;
    case "nominal":
      copiedBase = { kind: "nominal", path: base.path };
      break;
    case "action":
    case "invocation":
      copiedBase = { kind: base.kind, targets: base.targets === null ? null : Object.freeze([...base.targets]) };
      break;
    case "delivery":
      copiedBase = { kind: "delivery", operation: base.operation };
      break;
    case "enum":
      copiedBase = { kind: "enum", cases: Object.freeze([...base.cases]) };
      break;
    case "union":
      copiedBase = { kind: "union", arms: Object.freeze([...base.arms]) };
      break;
    default: {
      const _exhaustive: never = base;
      throw new PlanError("malformed-schema", `unknown type base ${JSON.stringify(_exhaustive)}`);
    }
  }
  return Object.freeze({
    base: Object.freeze(copiedBase),
    array: type.array,
    nullable: type.nullable,
    requiredArray: type.requiredArray,
  });
}

/** Reference targets a field type points at (ordered, copied). */
function typeRefs(type: NormalizedType): readonly string[] {
  const base = type.base;
  switch (base.kind) {
    case "nominal":
      return Object.freeze([base.path]);
    case "union":
      return Object.freeze([...base.arms]);
    case "enum":
      return Object.freeze([...base.cases]);
    case "action":
    case "invocation":
      return base.targets === null ? Object.freeze([]) : Object.freeze([...base.targets]);
    case "delivery":
      return base.operation === null ? Object.freeze([]) : Object.freeze([base.operation]);
    default:
      return Object.freeze([]);
  }
}

// ---------------------------------------------------------------------------
// Prepared plans.
// ---------------------------------------------------------------------------

/** Registry key for one field default. Opaque to callers. */
export interface DefaultRef {
  readonly kind: "default-ref";
  readonly key: string;
}

/** One ordered, immutable field plan. */
export interface PreparedFieldPlan {
  readonly name: string;
  readonly typeId: string;
  readonly type: NormalizedType;
  readonly required: boolean;
  readonly hasDefault: boolean;
  readonly defaultRef?: DefaultRef;
  readonly lengthMin?: number;
  readonly lengthMax?: number;
  readonly valueMin?: CanValue;
  readonly valueMax?: CanValue;
  readonly trim?: boolean;
  readonly serverOnly: boolean;
  readonly defaultOrigin?: FieldDefaultOrigin;
  /** Ordered reference targets (nominal path / union arms / enum cases). */
  readonly refs: readonly string[];
}

export interface PreparedContractPlan {
  readonly name: string;
  /** Fields in descriptor order. */
  readonly fields: readonly PreparedFieldPlan[];
  /** Field names in descriptor order (allowed list). */
  readonly allowed: readonly string[];
  /** Required field names in descriptor order. */
  readonly required: readonly string[];
}

export interface PreparedEnumPlan {
  readonly name: string;
  readonly cases: readonly string[];
}

export interface PreparedOperationPlan {
  readonly name: string;
  readonly inputs: readonly PreparedFieldPlan[];
  readonly allowed: readonly string[];
  readonly required: readonly string[];
  readonly mutation: boolean;
}

/** Generation-tagged, issuer-assigned plan handle. */
export type PlanId = string & { readonly __planId: unique symbol };

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value.startsWith("plan:");
}

/** One registered immutable owner plan. Deeply frozen. */
export interface PreparedValidationPlan {
  readonly id: PlanId;
  readonly profileVersion: string;
  /** Error-projection tag: the registering profile. Behavior stays legacy. */
  readonly errorProjection: string;
  readonly contracts: { readonly [name: string]: PreparedContractPlan };
  readonly contractOrder: readonly string[];
  readonly enums: { readonly [name: string]: PreparedEnumPlan };
  readonly enumOrder: readonly string[];
  readonly operations: { readonly [name: string]: PreparedOperationPlan };
  readonly operationOrder: readonly string[];
}

function planIdFor(state: OwnerState, sequence: number): PlanId {
  const { abiVersion, profileVersion, backendId, ownerRevision } = state.scope;
  return `plan:${abiVersion}:${profileVersion}:${backendId}:${ownerRevision}:g${state.generation}:${sequence}` as PlanId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldPlan(
  name: string,
  field: NormalizedField,
  defaultKey: string | undefined,
): PreparedFieldPlan {
  const plan: Record<string, unknown> = {
    name,
    typeId: field.typeId,
    type: copyFrozenType(field.type),
    required: field.required,
    hasDefault: field.hasDefault,
    serverOnly: field.serverOnly,
    refs: typeRefs(field.type),
  };
  if (defaultKey !== undefined) {
    plan["defaultRef"] = Object.freeze({ kind: "default-ref", key: defaultKey });
  }
  if (field.lengthMin !== undefined) plan["lengthMin"] = field.lengthMin;
  if (field.lengthMax !== undefined) plan["lengthMax"] = field.lengthMax;
  if (field.valueMin !== undefined) plan["valueMin"] = copyFrozenValue(field.valueMin);
  if (field.valueMax !== undefined) plan["valueMax"] = copyFrozenValue(field.valueMax);
  if (field.trim !== undefined) plan["trim"] = field.trim;
  if (field.defaultOrigin !== undefined) plan["defaultOrigin"] = field.defaultOrigin;
  return Object.freeze(plan) as unknown as PreparedFieldPlan;
}

/**
 * Register an immutable owner plan for a factory-produced schema.
 *
 * @param owner A token issued by `createPlanOwner` (foreign objects fail).
 * @param profileVersion Non-empty profile tag recorded as error projection.
 * @param schema A normalized schema carrying factory provenance. Strings
 *   (unknown wrappers), forged tags, frozen hand-builts, and structurally
 *   accepted legacy schemas fail here and stay on `validateValue`.
 * @returns The issuer-assigned generation-tagged `PlanId`.
 */
export function registerValidationPlan(owner: unknown, profileVersion: unknown, schema: unknown): PlanId {
  const state = ownerStateOf(owner, "registerValidationPlan");
  if (typeof profileVersion !== "string" || profileVersion.length === 0) {
    throw new PlanError("invalid-profile", "profile version must be a non-empty string");
  }
  if (typeof schema === "string") {
    throw new PlanError("legacy-wrapper", "unknown string wrappers stay outside the plan cache (legacy path)");
  }
  if (!isRecord(schema)) {
    throw new PlanError("malformed-schema", "plan registration requires a normalized schema object");
  }
  const provenance = provenanceOf(schema);
  if (provenance === undefined) {
    throw new PlanError(
      "missing-provenance",
      "schema lacks factory provenance (forged tags, frozen hand-builts, and structural acceptance stay legacy)",
    );
  }
  if (provenance.ownerRevision !== state.scope.ownerRevision) {
    throw new PlanError("stale-scope", "schema provenance revision does not match the owner scope");
  }
  const candidate = schema as Partial<NormalizedSchema>;
  if (
    candidate.kind !== "normalized-schema" ||
    !isRecord(candidate.contracts) ||
    !isRecord(candidate.enums) ||
    !isRecord(candidate.operations)
  ) {
    throw new PlanError("malformed-schema", "provenance-bearing schema fails the normalized shape gate");
  }
  // This prepared/native profile cannot preserve the new value constraints.
  // Refuse before copying a plan; public validation remains the canonical TS path.
  if (Object.hasOwn(candidate, "aliases")) {
    throw new PlanError("malformed-schema", "text aliases are outside the prepared validation profile");
  }
  for (const fields of [
    ...Object.values(candidate.contracts).map(contract => contract.fields),
    ...Object.values(candidate.operations).map(operation => operation.inputs),
  ]) {
    for (const field of Object.values(fields)) {
      if (["format", "distinctBy", "excludedIds"].some(key => Object.hasOwn(field, key))) {
        throw new PlanError("malformed-schema", "NAME and keyed-array constraints are outside the prepared validation profile");
      }
    }
  }
  const sequence = state.nextSequence++;
  const id = planIdFor(state, sequence);
  const rejectReservedName = (where: string, name: string): void => {
    // normalizeSchema refuses these at the factory; the plan registry
    // refuses them again so a provenance-bearing hand-built can neither
    // smuggle a prototype key into a plan map nor vanish through one.
    if (name === "__proto__") {
      throw new PlanError("malformed-schema", `${where} name "__proto__" is reserved`);
    }
  };

  const stagedDefaults = new Map<string, CanValue>();
  const registerDefault = (key: string, value: CanValue): void => {
    stagedDefaults.set(key, copyFrozenValue(value));
  };

  const contracts: Record<string, PreparedContractPlan> = {};
  const contractOrder: string[] = [];
  for (const [contractName, contract] of Object.entries(candidate.contracts)) {
    rejectReservedName("contract", contractName);
    const fields: PreparedFieldPlan[] = [];
    const allowed: string[] = [];
    const required: string[] = [];
    for (const [fieldName, field] of Object.entries(contract.fields)) {
      rejectReservedName("field", fieldName);
      const key = `${sequence}:contracts.${contractName}.fields.${fieldName}`;
      if (field.hasDefault) {
        if (field.default === undefined) {
          throw new PlanError("malformed-schema", `field ${contractName}.${fieldName} claims a default it lacks`);
        }
        registerDefault(key, field.default);
      }
      fields.push(fieldPlan(fieldName, field, field.hasDefault ? key : undefined));
      allowed.push(fieldName);
      if (field.required) required.push(fieldName);
    }
    contracts[contractName] = Object.freeze({
      name: contractName,
      fields: Object.freeze(fields),
      allowed: Object.freeze(allowed),
      required: Object.freeze(required),
    });
    contractOrder.push(contractName);
  }

  const enums: Record<string, PreparedEnumPlan> = {};
  const enumOrder: string[] = [];
  for (const [enumName, enumDef] of Object.entries(candidate.enums)) {
    rejectReservedName("enum", enumName);
    enums[enumName] = Object.freeze({ name: enumName, cases: Object.freeze([...enumDef.cases]) });
    enumOrder.push(enumName);
  }

  const operations: Record<string, PreparedOperationPlan> = {};
  const operationOrder: string[] = [];
  for (const [opName, op] of Object.entries(candidate.operations)) {
    rejectReservedName("operation", opName);
    const inputs: PreparedFieldPlan[] = [];
    const allowed: string[] = [];
    const required: string[] = [];
    for (const [inputName, field] of Object.entries(op.inputs)) {
      rejectReservedName("input", inputName);
      const key = `${sequence}:operations.${opName}.inputs.${inputName}`;
      if (field.hasDefault) {
        if (field.default === undefined) {
          throw new PlanError("malformed-schema", `input ${opName}.${inputName} claims a default it lacks`);
        }
        registerDefault(key, field.default);
      }
      inputs.push(fieldPlan(inputName, field, field.hasDefault ? key : undefined));
      allowed.push(inputName);
      if (field.required) required.push(inputName);
    }
    operations[opName] = Object.freeze({
      name: opName,
      inputs: Object.freeze(inputs),
      allowed: Object.freeze(allowed),
      required: Object.freeze(required),
      mutation: op.mutation,
    });
    operationOrder.push(opName);
  }

  const plan: PreparedValidationPlan = Object.freeze({
    id,
    profileVersion,
    errorProjection: profileVersion,
    contracts: Object.freeze(contracts),
    contractOrder: Object.freeze(contractOrder),
    enums: Object.freeze(enums),
    enumOrder: Object.freeze(enumOrder),
    operations: Object.freeze(operations),
    operationOrder: Object.freeze(operationOrder),
  });
  // Publish defaults only after the entire immutable plan has been built.
  for (const [key, value] of stagedDefaults) state.defaults.set(key, value);
  state.plans.set(sequence, plan);
  return id;
}

/** Read one registered plan. Unknown or released IDs fail closed. */
export function getValidationPlan(owner: unknown, id: unknown): PreparedValidationPlan {
  const state = ownerStateOf(owner, "getValidationPlan");
  if (!isPlanId(id)) {
    throw new PlanError("unknown-plan", "plan id must be an issued plan handle");
  }
  for (const plan of state.plans.values()) {
    if (plan.id === id) return plan;
  }
  throw new PlanError("unknown-plan", "no live plan for this handle in this owner scope");
}

/**
 * Resolve one field default through the owner's shared frozen registry.
 * Repeated resolution returns the identical object.
 */
export function resolvePlanDefault(owner: unknown, ref: unknown): CanValue {
  const state = ownerStateOf(owner, "resolvePlanDefault");
  if (!isRecord(ref) || ref["kind"] !== "default-ref" || typeof ref["key"] !== "string") {
    throw new PlanError("unknown-default", "default reference must be a plan-issued DefaultRef");
  }
  const value = state.defaults.get(ref["key"] as string);
  if (value === undefined) {
    throw new PlanError("unknown-default", "no registered default for this reference");
  }
  return value;
}

/** Release one plan. Idempotent: unknown or released IDs are silent no-ops. */
export function releaseValidationPlan(owner: unknown, id: unknown): void {
  const state = ownerStateOf(owner, "releaseValidationPlan");
  if (!isPlanId(id)) return;
  for (const [sequence, plan] of state.plans) {
    if (plan.id === id) {
      state.plans.delete(sequence);
      return;
    }
  }
}
