/**
 * Lane 02 schema validation: closed contract/enum/operation descriptors,
 * wire->value validation with structured violations, and operation-input
 * admission.
 *
 * Normative: DESIGN.md L121 (closed contracts, bounds, defaults, unknown
 * fields rejected), L123-133 (required/nullable/default/array-creation
 * forms; defaults run on creation only; partial updates distinguish
 * omitted from explicit null), L131 (min/max inclusive; text/array length
 * vs numeric value), L872 (closed JSON objects; unknown arguments fail;
 * mutations carry `operation_id`), L139 (reuse drops defaults/server/
 * required-array metadata); GRAMMAR.md L183 (required-array fields cannot
 * have defaults/initializers; parameters have no `!`).
 *
 * Minimal closed descriptor set:
 * - contracts: name -> {fields: name -> {type, min?, max?, default?}}
 * - enums: name -> {cases: [...]}
 * - operations: name -> {inputs: name -> {type, min?, max?, default?},
 *   mutation?}
 * Every level rejects unknown keys. Bounds are inclusive: text (and every
 * validated string-like) plus arrays take length bounds as non-negative
 * integer numbers; int/decimal/duration/money/date/datetime take value
 * bounds in wire form. No other type takes bounds.
 *
 * Boundaries recorded here:
 * - UNIQUENESS IS OUT OF SCOPE: `unique` needs stored state and lives in
 *   lane-03; a `unique` key in a field descriptor is rejected as unknown.
 * - `server`/`derived` creation metadata IS in this descriptor set (T09),
 *   on contract fields only (GRAMMAR L198: parameters have no server
 *   initializer). `server: true` (`server=expr`, DESIGN L129) and
 *   `derived: true` (`derive`, GRAMMAR L85) mark engine-resolved fields:
 *   they are never caller-required, an omitted one on create yields no key
 *   (the T18 engine supplies the value; the ENGINE_RESOLVED sentinel marks
 *   this internally and never appears in output), and the normalized field
 *   carries `serverOnly: true` plus its `defaultOrigin` so downstream
 *   admission excludes them from writable client inputs. An explicitly
 *   supplied value still validates strictly (DESIGN L403: fixtures are
 *   stored snapshots and may initialize server fields), with trim/bounds
 *   applying as usual. One initializer only: `server`/`derived` are
 *   mutually exclusive and reject `default` and `[]!` (GRAMMAR L192); a
 *   literal descriptor default cannot cover an engine-resolved subfield
 *   (explicit-complete values cannot spell engine values).
 *   `trim` IS supported, on text/string-like leaf (non-array) fields only:
 *   it is normalization (DESIGN L131), so the trimmed value is what bounds
 *   check — including explicit defaults, which trim before their bound
 *   check. Trim runs after wire validation, so it is ~no-op on email
 *   (padded addresses already fail `format`) and mostly redundant on url
 *   (WHATWG validation pre-trims); its force is on text. Normalization
 *   of locale/timezone/currency values is owned by the wire codec.
 * - Omitted array fields on create yield `[]` ONLY when bounds allow it: a
 *   `min` length bound rejects the implicit `[]` (fail-closed, matching an
 *   explicit `[]`). Update-mode omission still yields UPDATE_OMITTED.
 * - Reuse drops defaults: descriptors carry no inherited initializers —
 *   each field's default comes only from its own descriptor, and
 *   qualified field-reuse paths (`Model.field`) are NOT resolved here
 *   (no model registry in this set); a nominal outside contracts/enums is
 *   treated as a model reference, including dotted paths.
 * - Contract and enum names share one resolution namespace (an overlap is
 *   a descriptor error); operation names live in their own lookup.
 * - `validateValue` never returns a partial value: any violation throws
 *   SchemaError carrying every collected Violation. Unknown operations or
 *   malformed schemas/type ids are caller errors (ValueError); malformed
 *   wire and bad descriptors are SchemaError.
 * - Update mode: omitted contract fields become the UPDATE_OMITTED
 *   sentinel (never null), recursively through present contract-typed
 *   fields; array elements and union branches are always complete values
 *   (create-like: defaults apply, omissions of required fields fail).
 *   Defaults never apply in update partials.
 * - Mutation operation inputs require every caller-submitted model ref
 *   (however nested, including union branches and array elements) to
 *   carry an expected version; query inputs preserve versions without
 *   requiring them. Schema-authored defaults are shape-validated only,
 *   and whether a mutation may use a versionless defaulted ref is
 *   lane-03 admission semantics.
 *   `operation_id` is required non-empty text for mutations and rejected
 *   as an unknown argument for queries; it is reserved in every
 *   operation's declared inputs.
 * - Descriptor defaults must be explicit-complete values: nested
 *   contract-typed objects inside a default do not inherit nested
 *   defaults (omitted nested fields with defaults are descriptor
 *   errors); nullable/array-implicit leaves still fill in.
 * - `T[]?` omitted on create yields null (nullability wins over the
 *   `[]` empty default). An explicit `default: null` is allowed only on
 *   nullable types.
 * - All outputs (schemas, values, validated args) are frozen; validated
 *   defaults are shared frozen references.
 */

import type {
  CanValue,
  ContractValue,
  FieldDefaultOrigin,
  MoneyValue,
  Violation,
  ViolationCode,
} from "@canlang/contracts/values";
import { emptyArray } from "./array.js";
import { compareDecimal, isDecimal } from "./decimal.js";
import { SchemaError, ValueError } from "./errors.js";
import { isDateValue, isDatetime, isMoney, isRecordRef, makeUnionValue } from "./kinds.js";
import { compareDate, compareInstant } from "./temporal.js";
import { scalarLength, trim as trimText } from "./text.js";
import { parseTypeId, printTypeBase, printTypeId, type NormalizedType } from "./types.js";
import { decodeValue, encodeValue } from "./wire.js";

export type ValidationMode = "create" | "update";

/**
 * Sentinel for an omitted field in update validation. Lane-03 merges it
 * (omitted stays omitted); it is never null and never a CanValue.
 */
export const UPDATE_OMITTED: unique symbol = Symbol("canlang.values.update-omitted");

export function isUpdateOmitted(value: unknown): value is typeof UPDATE_OMITTED {
  return value === UPDATE_OMITTED;
}

/**
 * Sentinel for an omitted engine-resolved (`server`/`derived`) field on
 * create (T09). Callers drop the key from validated output — the T18 engine
 * supplies the value — so this never appears in a returned value and is
 * never a CanValue.
 */
export const ENGINE_RESOLVED: unique symbol = Symbol("canlang.values.engine-resolved");

export function isEngineResolved(value: unknown): value is typeof ENGINE_RESOLVED {
  return value === ENGINE_RESOLVED;
}

/** Update-mode contract result: fields hold values, nested partials, or the sentinel. */
export interface UpdateContract {
  readonly [field: string]: CanValue | UpdateContract | typeof UPDATE_OMITTED;
}

// ---------------------------------------------------------------------------
// Descriptors (authored input; validated by normalizeSchema).
// ---------------------------------------------------------------------------

/** One contract field or operation input as authored. Bounds/defaults are wire form. */
export interface FieldDescriptor {
  readonly type: string;
  readonly min?: unknown;
  readonly max?: unknown;
  readonly default?: unknown;
  /** Normalization (DESIGN L131): trim before bounds; text/string-like leaves only. */
  readonly trim?: boolean;
  /**
   * T09 creation metadata, contract fields only: `server` (`server=expr`,
   * DESIGN L129) and `derived` (`derive`, GRAMMAR L85) mark engine-resolved
   * fields. Effective only when `true`; mutually exclusive with each other,
   * with `default`, and with `[]!` (GRAMMAR L192).
   */
  readonly server?: boolean;
  readonly derived?: boolean;
}

export interface ContractDescriptor {
  readonly fields: Record<string, FieldDescriptor>;
}

export interface EnumDescriptor {
  readonly cases: readonly string[];
}

export interface OperationDescriptor {
  readonly inputs: Record<string, FieldDescriptor>;
  readonly mutation?: boolean;
}

export interface SchemaDescriptor {
  readonly contracts?: Record<string, ContractDescriptor>;
  readonly enums?: Record<string, EnumDescriptor>;
  readonly operations?: Record<string, OperationDescriptor>;
}

// ---------------------------------------------------------------------------
// Normalized schema (validated output; the only accepted validation input).
// ---------------------------------------------------------------------------

export interface NormalizedField {
  readonly type: NormalizedType;
  readonly typeId: string;
  readonly required: boolean;
  readonly hasDefault: boolean;
  readonly lengthMin?: number;
  readonly lengthMax?: number;
  readonly valueMin?: CanValue;
  readonly valueMax?: CanValue;
  readonly default?: CanValue;
  readonly trim?: boolean;
  /**
   * T09: true exactly for engine-resolved (`server`/`derived`) fields.
   * Mirrors T04a `CanonicalFieldDef.serverOnly`: downstream admission
   * excludes these from writable client inputs.
   */
  readonly serverOnly: boolean;
  /**
   * T09 creation-default origin: `literal` for authored `default` values,
   * `server`/`derived` for engine-resolved fields, absent otherwise.
   */
  readonly defaultOrigin?: FieldDefaultOrigin;
}

export interface NormalizedContract {
  readonly fields: { readonly [field: string]: NormalizedField };
}

export interface NormalizedEnum {
  readonly cases: readonly string[];
}

export interface NormalizedOperation {
  readonly inputs: { readonly [input: string]: NormalizedField };
  readonly mutation: boolean;
}

export interface NormalizedSchema {
  readonly kind: "normalized-schema";
  readonly contracts: { readonly [name: string]: NormalizedContract };
  readonly enums: { readonly [name: string]: NormalizedEnum };
  readonly operations: { readonly [name: string]: NormalizedOperation };
}

// ---------------------------------------------------------------------------
// Internal validation machinery.
// ---------------------------------------------------------------------------

type Path = ReadonlyArray<string | number>;

/** Internal failure marker; the violation is already recorded. */
const FAIL: unique symbol = Symbol("canlang.schema.fail");

type NodeOut = CanValue | UpdateContract | typeof UPDATE_OMITTED | typeof FAIL;

/** Omission outcome: validated fills plus the engine-resolved drop marker. */
type OmittedOut = CanValue | UpdateContract | typeof UPDATE_OMITTED | typeof ENGINE_RESOLVED | typeof FAIL;

/**
 * Omission handling: "create" fills defaults/null/[] and reports missing
 * required fields; "update" yields UPDATE_OMITTED; "explicit" (descriptor
 * defaults) requires every field spelled out except nullable/array-implicit
 * leaves. Array elements and union branches are always "create"/"explicit"
 * (complete values), never partial.
 */
type Nesting = "create" | "update" | "explicit";

interface NodeOptions {
  readonly nesting: Nesting;
  readonly requireVersion: boolean;
}

interface Collector {
  readonly violations: Violation[];
}

function pushViolation(
  ctx: Collector,
  path: Path,
  code: ViolationCode,
  message: string,
  expected?: string,
  actual?: string,
): void {
  const frozenPath = Object.freeze([...path]);
  if (expected === undefined) {
    ctx.violations.push({ path: frozenPath, code, message });
  } else if (actual === undefined) {
    ctx.violations.push({ path: frozenPath, code, message, expected });
  } else {
    ctx.violations.push({ path: frozenPath, code, message, expected, actual });
  }
}

function actualWire(wire: unknown): string {
  if (wire === null) {
    return "null";
  }
  switch (typeof wire) {
    case "string":
      return wire.length > 60 ? `${JSON.stringify(wire.slice(0, 60))}...` : (JSON.stringify(wire) as string);
    case "number":
      return `number ${String(wire)}`;
    case "boolean":
      return wire ? "true" : "false";
    case "bigint":
      return `bigint ${wire.toString()}`;
    case "undefined":
      return "undefined";
    default:
      break;
  }
  if (Array.isArray(wire)) {
    return `array of length ${wire.length}`;
  }
  if (typeof wire === "object") {
    return `object with keys [${Object.keys(wire).slice(0, 5).join(", ")}]`;
  }
  return typeof wire;
}

function isObject(wire: unknown): wire is Record<string, unknown> {
  return typeof wire === "object" && wire !== null && !Array.isArray(wire);
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * `__proto__` passes NAME_RE/PATH_RE but would silently set the prototype
 * (instead of an own key) when accumulated onto plain objects, losing the
 * declaration from validated output — so it is rejected as a reserved name
 * everywhere a name becomes an object key. Other dunder names
 * ("constructor", "prototype") are safe own keys and stay allowed.
 */
function isReservedName(name: string): boolean {
  return name === "__proto__";
}

/** Minimal schema surface the validators read (pending schemas qualify too). */
interface FieldView {
  readonly type: NormalizedType;
  readonly required: boolean;
  readonly hasDefault: boolean;
  readonly default?: CanValue;
  readonly lengthMin?: number;
  readonly lengthMax?: number;
  readonly valueMin?: CanValue;
  readonly valueMax?: CanValue;
  readonly trim?: boolean;
  readonly serverOnly: boolean;
  readonly defaultOrigin?: FieldDefaultOrigin;
}

interface SchemaView {
  readonly contracts: { readonly [name: string]: { readonly fields: { readonly [field: string]: FieldView } } };
  readonly enums: { readonly [name: string]: { readonly cases: readonly string[] } };
}

function assertNormalizedSchema(schema: unknown): asserts schema is NormalizedSchema {
  if (
    !isObject(schema) ||
    schema["kind"] !== "normalized-schema" ||
    !isObject(schema["contracts"]) ||
    !isObject(schema["enums"]) ||
    !isObject(schema["operations"])
  ) {
    throw new ValueError("invalid-construction", "expected a NormalizedSchema from normalizeSchema");
  }
}

/**
 * Compares a validated value against a bound of the same kind: -1/0/1, or
 * null when the pair is unorderable (money across currencies).
 */
function compareBound(kind: string, value: CanValue, bound: CanValue): -1 | 0 | 1 | null {
  switch (kind) {
    case "int":
    case "duration":
      if (typeof value !== "bigint" || typeof bound !== "bigint") {
        return null;
      }
      if (value < bound) {
        return -1;
      }
      if (value > bound) {
        return 1;
      }
      return 0;
    case "decimal":
      if (!isDecimal(value) || !isDecimal(bound)) {
        return null;
      }
      return compareDecimal(value, bound);
    case "money": {
      if (!isMoney(value) || !isMoney(bound)) {
        return null;
      }
      if (value.currency !== bound.currency) {
        return null;
      }
      if (value.minor < bound.minor) {
        return -1;
      }
      if (value.minor > bound.minor) {
        return 1;
      }
      return 0;
    }
    case "date": {
      if (!isDateValue(value) || !isDateValue(bound)) {
        return null;
      }
      const order = compareDate(value, bound);
      return order < 0 ? -1 : order > 0 ? 1 : 0;
    }
    case "datetime": {
      if (!isDatetime(value) || !isDatetime(bound)) {
        return null;
      }
      const order = compareInstant(value, bound);
      return order < 0 ? -1 : order > 0 ? 1 : 0;
    }
    default:
      return null;
  }
}

/** Renders a bound/value in wire form for violation `expected`/`actual`. */
function renderBound(leafId: string, value: CanValue): string {
  return JSON.stringify(encodeValue(leafId, value)) as string;
}

/**
 * Inclusive bound check on an already-validated non-null value. Bounds run
 * after normalization (DESIGN L131); money across currencies cannot order.
 */
function checkBounds(field: FieldView, value: CanValue, path: Path, ctx: Collector): void {
  const lengthMin = field.lengthMin;
  const lengthMax = field.lengthMax;
  if (lengthMin !== undefined || lengthMax !== undefined) {
    const length =
      typeof value === "string" ? Number(scalarLength(value)) : Array.isArray(value) ? value.length : null;
    if (length === null) {
      return;
    }
    if (lengthMin !== undefined && length < lengthMin) {
      pushViolation(
        ctx,
        path,
        "bound",
        `length ${length} is below the minimum of ${lengthMin}`,
        `length >= ${lengthMin}`,
        `length ${length}`,
      );
    }
    if (lengthMax !== undefined && length > lengthMax) {
      pushViolation(
        ctx,
        path,
        "bound",
        `length ${length} is above the maximum of ${lengthMax}`,
        `length <= ${lengthMax}`,
        `length ${length}`,
      );
    }
    return;
  }
  const valueMin = field.valueMin;
  const valueMax = field.valueMax;
  if (valueMin === undefined && valueMax === undefined) {
    return;
  }
  const base = field.type.base;
  if (base.kind !== "scalar") {
    return;
  }
  const leafId = printTypeBase(base);
  if (valueMin !== undefined) {
    const order = compareBound(base.name, value, valueMin);
    if (order === null) {
      pushViolation(
        ctx,
        path,
        "bound",
        "money bound needs a matching currency",
        `currency ${(valueMin as MoneyValue).currency}`,
        renderBound(leafId, value),
      );
    } else if (order < 0) {
      pushViolation(
        ctx,
        path,
        "bound",
        "value is below the minimum",
        `>= ${renderBound(leafId, valueMin)}`,
        renderBound(leafId, value),
      );
    }
  }
  if (valueMax !== undefined) {
    const order = compareBound(base.name, value, valueMax);
    if (order === null) {
      pushViolation(
        ctx,
        path,
        "bound",
        "money bound needs a matching currency",
        `currency ${(valueMax as MoneyValue).currency}`,
        renderBound(leafId, value),
      );
    } else if (order > 0) {
      pushViolation(
        ctx,
        path,
        "bound",
        "value is above the maximum",
        `<= ${renderBound(leafId, valueMax)}`,
        renderBound(leafId, value),
      );
    }
  }
}

/** Applies accumulated SchemaError violations from a leaf decode to this path. */
function mergeLeafError(ctx: Collector, path: Path, err: unknown): void {
  if (!(err instanceof SchemaError)) {
    throw err;
  }
  for (const violation of err.violations) {
    pushViolation(
      ctx,
      [...path, ...violation.path],
      violation.code,
      violation.message,
      violation.expected,
      violation.actual,
    );
  }
}

function validateLeaf(leafId: string, wire: unknown, path: Path, ctx: Collector): NodeOut {
  try {
    return decodeValue(leafId, wire);
  } catch (err) {
    mergeLeafError(ctx, path, err);
    return FAIL;
  }
}

function hasBounds(field: FieldView): boolean {
  return (
    field.lengthMin !== undefined ||
    field.lengthMax !== undefined ||
    field.valueMin !== undefined ||
    field.valueMax !== undefined
  );
}

/**
 * Normalization for leaf string values (DESIGN L131: constraints run after
 * normalization). Applies only when the field opts in with `trim: true`
 * and the decoded value is a string; null and non-strings pass through.
 * Callers run this before `checkBounds`, including pass-2 defaults.
 */
function applyTrim(
  field: FieldView,
  decoded: CanValue | UpdateContract | typeof UPDATE_OMITTED,
): CanValue | UpdateContract | typeof UPDATE_OMITTED {
  if (field.trim === true && typeof decoded === "string") {
    return trimText(decoded);
  }
  return decoded;
}

function validateEnumValue(
  name: string,
  cases: readonly string[],
  wire: unknown,
  path: Path,
  ctx: Collector,
): NodeOut {
  if (typeof wire !== "string") {
    pushViolation(ctx, path, "type", `enum ${name} expects a case name`, `one of: ${cases.join(", ")}`, actualWire(wire));
    return FAIL;
  }
  if (!cases.includes(wire)) {
    pushViolation(
      ctx,
      path,
      "format",
      `unknown case ${JSON.stringify(wire)} for enum ${name}`,
      `one of: ${cases.join(", ")}`,
      actualWire(wire),
    );
    return FAIL;
  }
  return wire;
}

function validateModelRef(
  name: string,
  wire: unknown,
  path: Path,
  ctx: Collector,
  options: NodeOptions,
): NodeOut {
  let decoded: CanValue;
  try {
    decoded = decodeValue(name, wire);
  } catch (err) {
    mergeLeafError(ctx, path, err);
    return FAIL;
  }
  if (!isRecordRef(decoded)) {
    pushViolation(
      ctx,
      path,
      "type",
      `model ${name} expects a record reference`,
      `ref ${name} ({id} or {id, version})`,
      actualWire(wire),
    );
    return FAIL;
  }
  if (options.requireVersion && decoded.version === undefined) {
    pushViolation(
      ctx,
      [...path, "version"],
      "required",
      `mutation input ref to ${name} requires an expected version`,
      `ref ${name} {id, version}`,
    );
    return FAIL;
  }
  return decoded;
}

function omittedField(field: FieldView, path: Path, ctx: Collector, options: NodeOptions): OmittedOut {
  if (options.nesting === "update") {
    return UPDATE_OMITTED;
  }
  if (field.required) {
    pushViolation(ctx, path, "required", "missing required field", printTypeId(field.type));
    return FAIL;
  }
  if (field.hasDefault) {
    if (options.nesting === "explicit") {
      pushViolation(
        ctx,
        path,
        "required",
        "default values must specify every field explicitly; nested defaults do not compose",
        printTypeId(field.type),
      );
      return FAIL;
    }
    const fallback = field.default;
    if (fallback === undefined) {
      throw new ValueError("invalid-construction", "normalized field with hasDefault lacks its default");
    }
    return fallback;
  }
  // Engine-resolved (server/derived) fields: on create the key drops from
  // validated output (the T18 engine supplies the value). A literal
  // descriptor default cannot cover one: explicit-complete values cannot
  // spell engine values.
  if (field.defaultOrigin === "server" || field.defaultOrigin === "derived") {
    if (options.nesting === "explicit") {
      pushViolation(
        ctx,
        path,
        "required",
        "a literal default cannot cover an engine-resolved (server/derived) field",
        printTypeId(field.type),
      );
      return FAIL;
    }
    return ENGINE_RESOLVED;
  }
  if (field.type.nullable) {
    return null;
  }
  // Update mode returned the sentinel above, so only create/explicit reach
  // here: the implicit `[]` must satisfy length bounds like an explicit one.
  const empty = emptyArray<CanValue>() as CanValue[];
  const before = ctx.violations.length;
  checkBounds(field, empty, path, ctx);
  if (ctx.violations.length !== before) {
    return FAIL;
  }
  return empty;
}

function validateContractValue(
  schema: SchemaView,
  name: string,
  contract: { readonly fields: { readonly [field: string]: FieldView } },
  wire: unknown,
  path: Path,
  ctx: Collector,
  options: NodeOptions,
): NodeOut {
  if (!isObject(wire)) {
    pushViolation(ctx, path, "type", `contract ${name} expects an object`, `contract ${name}`, actualWire(wire));
    return FAIL;
  }
  const declared = Object.keys(contract.fields);
  const known = new Set(declared);
  let ok = true;
  for (const key of Object.keys(wire)) {
    if (wire[key] !== undefined && !known.has(key)) {
      ok = false;
      pushViolation(
        ctx,
        [...path, key],
        "unknown-field",
        `contract ${name} has no field ${JSON.stringify(key)}`,
        declared.length === 0 ? "no declared fields" : `one of: ${declared.join(", ")}`,
        actualWire(wire[key]),
      );
    }
  }
  const out: Record<string, CanValue | UpdateContract | typeof UPDATE_OMITTED> = {};
  for (const [fieldName, field] of Object.entries(contract.fields)) {
    const fieldPath: Path = [...path, fieldName];
    const raw = Object.hasOwn(wire, fieldName) ? wire[fieldName] : undefined;
    if (raw === undefined) {
      const omitted = omittedField(field, fieldPath, ctx, options);
      if (omitted === FAIL) {
        ok = false;
      } else if (!isEngineResolved(omitted)) {
        out[fieldName] = omitted;
      }
      continue;
    }
    const before = ctx.violations.length;
    const decoded = validateNode(schema, field.type, raw, fieldPath, ctx, options);
    if (decoded === FAIL) {
      ok = false;
      continue;
    }
    // Normalization runs before constraints (DESIGN L131); trim fields are
    // leaves, so a trimmed value is always a plain string, never a partial.
    const stored = applyTrim(field, decoded);
    out[fieldName] = stored;
    // Bounded fields are scalar/text/array-typed, so a clean bounded value
    // is always a CanValue (never the sentinel or a partial).
    if (hasBounds(field) && ctx.violations.length === before && stored !== UPDATE_OMITTED && stored !== null) {
      checkBounds(field, stored as CanValue, fieldPath, ctx);
      if (ctx.violations.length !== before) {
        ok = false;
      }
    }
  }
  if (!ok) {
    return FAIL;
  }
  return Object.freeze(out) as CanValue | UpdateContract;
}

function validateUnionValue(
  schema: SchemaView,
  arms: readonly string[],
  wire: unknown,
  path: Path,
  ctx: Collector,
  options: NodeOptions,
): NodeOut {
  if (!isObject(wire)) {
    pushViolation(ctx, path, "type", "union expects an object", "union {type, value}", actualWire(wire));
    return FAIL;
  }
  let ok = true;
  for (const key of ["type", "value"] as const) {
    if (!Object.hasOwn(wire, key) || wire[key] === undefined) {
      ok = false;
      pushViolation(ctx, [...path, key], "required", `union is missing ${JSON.stringify(key)}`, "union {type, value}");
    }
  }
  for (const key of Object.keys(wire)) {
    if (wire[key] !== undefined && key !== "type" && key !== "value") {
      ok = false;
      pushViolation(
        ctx,
        [...path, key],
        "unknown-field",
        `union has no field ${JSON.stringify(key)}`,
        "union {type, value}",
        actualWire(wire[key]),
      );
    }
  }
  const rawType = wire["type"];
  let arm: string | null = null;
  if (rawType !== undefined) {
    if (typeof rawType !== "string") {
      ok = false;
      pushViolation(ctx, [...path, "type"], "type", "union discriminator must be text", "a declared arm name", actualWire(rawType));
    } else if (!arms.includes(rawType)) {
      ok = false;
      pushViolation(
        ctx,
        [...path, "type"],
        "type",
        "union discriminator names no declared arm",
        `one of: ${arms.join(", ")}`,
        actualWire(rawType),
      );
    } else {
      arm = rawType;
    }
  }
  // Union branches are complete values even in update partials.
  const complete: NodeOptions =
    options.nesting === "explicit"
      ? { nesting: "explicit", requireVersion: options.requireVersion }
      : { nesting: "create", requireVersion: options.requireVersion };
  const rawValue = wire["value"];
  let inner: NodeOut = FAIL;
  if (rawValue !== undefined && arm !== null) {
    const decoded = validateNode(schema, parseTypeId(arm), rawValue, [...path, "value"], ctx, complete);
    if (decoded === FAIL || decoded === UPDATE_OMITTED) {
      ok = false;
    } else {
      inner = decoded;
    }
  }
  if (!ok || arm === null || inner === FAIL) {
    return FAIL;
  }
  return makeUnionValue(arm, inner as CanValue);
}

function validateNode(
  schema: SchemaView,
  ast: NormalizedType,
  wire: unknown,
  path: Path,
  ctx: Collector,
  options: NodeOptions,
): NodeOut {
  if (wire === null) {
    if (ast.nullable) {
      return null;
    }
    pushViolation(ctx, path, "type", "null for a non-nullable type", `non-null ${printTypeId(ast)}`, "null");
    return FAIL;
  }
  if (wire === undefined) {
    pushViolation(ctx, path, "type", "missing value", printTypeId(ast), "undefined");
    return FAIL;
  }
  if (ast.array) {
    if (!Array.isArray(wire)) {
      pushViolation(ctx, path, "type", "expected an array", printTypeId(ast), actualWire(wire));
      return FAIL;
    }
    const element: NormalizedType = { base: ast.base, array: false, nullable: false, requiredArray: false };
    // Array elements are complete values even in update partials.
    const complete: NodeOptions =
      options.nesting === "explicit"
        ? { nesting: "explicit", requireVersion: options.requireVersion }
        : { nesting: "create", requireVersion: options.requireVersion };
    const out: CanValue[] = [];
    let ok = true;
    for (let index = 0; index < wire.length; index += 1) {
      const decoded = validateNode(schema, element, wire[index], [...path, index], ctx, complete);
      if (decoded === FAIL || decoded === UPDATE_OMITTED) {
        ok = false;
      } else {
        out.push(decoded as CanValue);
      }
    }
    return ok ? (Object.freeze(out) as CanValue[]) : FAIL;
  }
  const base = ast.base;
  switch (base.kind) {
    case "union":
      return validateUnionValue(schema, base.arms, wire, path, ctx, options);
    case "nominal": {
      const contract = schema.contracts[base.path];
      if (contract !== undefined) {
        return validateContractValue(schema, base.path, contract, wire, path, ctx, options);
      }
      const enumeration = schema.enums[base.path];
      if (enumeration !== undefined) {
        return validateEnumValue(base.path, enumeration.cases, wire, path, ctx);
      }
      return validateModelRef(base.path, wire, path, ctx, options);
    }
    default:
      return validateLeaf(printTypeBase(base), wire, path, ctx);
  }
}

// ---------------------------------------------------------------------------
// Descriptor normalization.
// ---------------------------------------------------------------------------

/** Pass-1 field: everything but the validated default (pass 2 fills it). */
interface PendingField extends FieldView {
  readonly rawDefault: unknown;
}

function isAbsent(value: unknown): boolean {
  return value === undefined;
}

function normalizeLengthBound(
  raw: unknown,
  key: string,
  path: Path,
  ctx: Collector,
): number | null {
  if (typeof raw !== "number") {
    pushViolation(
      ctx,
      [...path, key],
      "type",
      `length bound ${JSON.stringify(key)} must be a number`,
      "a non-negative integer length",
      actualWire(raw),
    );
    return null;
  }
  if (!Number.isInteger(raw) || raw < 0) {
    pushViolation(
      ctx,
      [...path, key],
      "format",
      `length bound ${JSON.stringify(key)} must be a non-negative integer`,
      "a non-negative integer length",
      actualWire(raw),
    );
    return null;
  }
  return raw;
}

function normalizeValueBound(
  leafId: string,
  raw: unknown,
  key: string,
  path: Path,
  ctx: Collector,
): CanValue | null {
  try {
    return decodeValue(leafId, raw);
  } catch (err) {
    if (!(err instanceof SchemaError)) {
      throw err;
    }
    for (const violation of err.violations) {
      pushViolation(
        ctx,
        [...path, key, ...violation.path],
        violation.code,
        violation.message,
        violation.expected,
        violation.actual,
      );
    }
    return null;
  }
}

function normalizeField(
  desc: unknown,
  path: Path,
  ctx: Collector,
  allowRequiredArray: boolean,
  allowServerInit: boolean,
): PendingField | null {
  if (!isObject(desc)) {
    pushViolation(
      ctx,
      path,
      "type",
      "field descriptor must be an object",
      "{type, min?, max?, default?, trim?, server?, derived?}",
      actualWire(desc),
    );
    return null;
  }
  let ok = true;
  for (const key of Object.keys(desc)) {
    if (
      key !== "type" &&
      key !== "min" &&
      key !== "max" &&
      key !== "default" &&
      key !== "trim" &&
      key !== "server" &&
      key !== "derived"
    ) {
      ok = false;
      pushViolation(
        ctx,
        [...path, key],
        "unknown-field",
        `unknown field-descriptor key ${JSON.stringify(key)}`,
        "one of: type, min, max, default, trim, server, derived",
        actualWire(desc[key]),
      );
    }
  }
  const typeRaw = desc["type"];
  let ast: NormalizedType | null = null;
  if (isAbsent(typeRaw)) {
    ok = false;
    pushViolation(ctx, [...path, "type"], "required", "field descriptor is missing its type", "a canonical type id");
  } else if (typeof typeRaw !== "string") {
    ok = false;
    pushViolation(
      ctx,
      [...path, "type"],
      "type",
      "field type must be a type id string",
      "a canonical type id",
      actualWire(typeRaw),
    );
  } else {
    try {
      ast = parseTypeId(typeRaw);
    } catch (err) {
      ok = false;
      if (!(err instanceof ValueError)) {
        throw err;
      }
      pushViolation(
        ctx,
        [...path, "type"],
        "format",
        `invalid type id: ${err.message}`,
        "a canonical type id",
        actualWire(typeRaw),
      );
    }
    if (ast !== null && ast.requiredArray && !allowRequiredArray) {
      ok = false;
      pushViolation(
        ctx,
        [...path, "type"],
        "format",
        "the field-only []! marker is not allowed on operation inputs",
        "a type without []!",
        actualWire(typeRaw),
      );
      ast = null;
    }
  }
  const hasDefault = Object.hasOwn(desc, "default") && !isAbsent(desc["default"]);
  const rawDefault: unknown = desc["default"];
  if (ast !== null && ast.requiredArray && hasDefault) {
    ok = false;
    pushViolation(
      ctx,
      [...path, "default"],
      "format",
      "a required-array-input field cannot have a default",
      "no default alongside []!",
    );
  }
  // T09 engine-resolved markers: booleans, effective only when true, one
  // initializer only (GRAMMAR L192), contract fields only (GRAMMAR L198).
  let server = false;
  let derived = false;
  for (const key of ["server", "derived"] as const) {
    const raw = Object.hasOwn(desc, key) ? desc[key] : undefined;
    if (isAbsent(raw)) {
      continue;
    }
    if (typeof raw !== "boolean") {
      ok = false;
      pushViolation(
        ctx,
        [...path, key],
        "type",
        `${key} must be a boolean`,
        "a boolean",
        actualWire(raw),
      );
      continue;
    }
    if (raw && !allowServerInit) {
      ok = false;
      pushViolation(
        ctx,
        [...path, key],
        "format",
        key === "server"
          ? "server initialization is not allowed on operation inputs"
          : "derived fields are not allowed on operation inputs",
        "no server/derived marker on operation inputs",
        actualWire(raw),
      );
      continue;
    }
    if (raw) {
      if (key === "server") {
        server = true;
      } else {
        derived = true;
      }
    }
  }
  if (server && derived) {
    ok = false;
    pushViolation(
      ctx,
      [...path, "derived"],
      "format",
      "a field cannot be both server-initialized and derived",
      "exactly one of server, derived",
    );
  }
  if ((server || derived) && hasDefault) {
    ok = false;
    pushViolation(
      ctx,
      [...path, "default"],
      "format",
      "a server-initialized or derived field cannot also have a default",
      "exactly one initializer",
    );
  }
  if (ast !== null && ast.requiredArray && (server || derived)) {
    ok = false;
    pushViolation(
      ctx,
      server ? [...path, "server"] : [...path, "derived"],
      "format",
      server
        ? "a required-array-input field cannot have a server initializer"
        : "a required-array-input field cannot be derived",
      "no server/derived marker alongside []!",
    );
  }
  const trimRaw = Object.hasOwn(desc, "trim") ? desc["trim"] : undefined;
  let trim: boolean | undefined;
  if (!isAbsent(trimRaw)) {
    if (typeof trimRaw !== "boolean") {
      ok = false;
      pushViolation(
        ctx,
        [...path, "trim"],
        "type",
        "trim must be a boolean",
        "a boolean",
        actualWire(trimRaw),
      );
    } else if (ast !== null) {
      const base = ast.base;
      const trimmable =
        !ast.array && ((base.kind === "scalar" && base.name === "text") || base.kind === "stringlike");
      if (!trimmable) {
        ok = false;
        pushViolation(
          ctx,
          [...path, "trim"],
          "type",
          `trim is only supported on text fields, not ${printTypeId(ast)}`,
          "a text or validated-string leaf field",
          actualWire(trimRaw),
        );
      } else {
        trim = trimRaw;
      }
    }
  }
  const hasMin = Object.hasOwn(desc, "min") && !isAbsent(desc["min"]);
  const hasMax = Object.hasOwn(desc, "max") && !isAbsent(desc["max"]);
  let lengthMin: number | undefined;
  let lengthMax: number | undefined;
  let valueMin: CanValue | undefined;
  let valueMax: CanValue | undefined;
  if ((hasMin || hasMax) && ast !== null) {
    const base = ast.base;
    const takesLength =
      ast.array || (base.kind === "scalar" && base.name === "text") || base.kind === "stringlike";
    const takesValue =
      !ast.array &&
      base.kind === "scalar" &&
      (base.name === "int" ||
        base.name === "decimal" ||
        base.name === "duration" ||
        base.name === "money" ||
        base.name === "date" ||
        base.name === "datetime");
    if (!takesLength && !takesValue) {
      ok = false;
      for (const key of ["min", "max"] as const) {
        if (Object.hasOwn(desc, key) && !isAbsent(desc[key])) {
          pushViolation(
            ctx,
            [...path, key],
            "type",
            `bounds are not supported on ${printTypeId(ast)}`,
            "no min/max on this type",
            actualWire(desc[key]),
          );
        }
      }
    } else if (takesLength) {
      if (hasMin) {
        const bound = normalizeLengthBound(desc["min"], "min", path, ctx);
        if (bound === null) {
          ok = false;
        } else {
          lengthMin = bound;
        }
      }
      if (hasMax) {
        const bound = normalizeLengthBound(desc["max"], "max", path, ctx);
        if (bound === null) {
          ok = false;
        } else {
          lengthMax = bound;
        }
      }
      if (lengthMin !== undefined && lengthMax !== undefined && lengthMin > lengthMax) {
        ok = false;
        pushViolation(ctx, [...path, "max"], "bound", "max is below min", `length <= ${lengthMin}`, `length ${lengthMax}`);
      }
    } else {
      const leafId = printTypeBase(base);
      if (hasMin) {
        const bound = normalizeValueBound(leafId, desc["min"], "min", path, ctx);
        if (bound === null) {
          ok = false;
        } else {
          valueMin = bound;
        }
      }
      if (hasMax) {
        const bound = normalizeValueBound(leafId, desc["max"], "max", path, ctx);
        if (bound === null) {
          ok = false;
        } else {
          valueMax = bound;
        }
      }
      if (valueMin !== undefined && valueMax !== undefined && base.kind === "scalar") {
        const order = compareBound(base.name, valueMin, valueMax);
        if (order === null) {
          ok = false;
          pushViolation(
            ctx,
            [...path, "max"],
            "bound",
            "money bounds need matching currencies",
            `currency ${(valueMin as MoneyValue).currency}`,
            actualWire(desc["max"]),
          );
        } else if (order > 0) {
          ok = false;
          pushViolation(
            ctx,
            [...path, "max"],
            "bound",
            "max is below min",
            `<= ${renderBound(leafId, valueMin)}`,
            renderBound(leafId, valueMax),
          );
        }
      }
    }
  }
  if (!ok || ast === null) {
    return null;
  }
  const engineResolved = server || derived;
  const defaultOrigin: FieldDefaultOrigin | undefined = hasDefault
    ? "literal"
    : server
      ? "server"
      : derived
        ? "derived"
        : undefined;
  const required = !ast.nullable && !hasDefault && !engineResolved && !(ast.array && !ast.requiredArray);
  return {
    type: ast,
    required,
    hasDefault,
    rawDefault,
    serverOnly: engineResolved,
    ...(defaultOrigin !== undefined ? { defaultOrigin } : {}),
    ...(lengthMin !== undefined ? { lengthMin } : {}),
    ...(lengthMax !== undefined ? { lengthMax } : {}),
    ...(valueMin !== undefined ? { valueMin } : {}),
    ...(valueMax !== undefined ? { valueMax } : {}),
    ...(trim !== undefined ? { trim } : {}),
  };
}

function normalizeEnumCases(desc: unknown, name: string, path: Path, ctx: Collector): string[] | null {
  if (!isObject(desc)) {
    pushViolation(ctx, path, "type", `enum ${name} descriptor must be an object`, "{cases: [...]}", actualWire(desc));
    return null;
  }
  let ok = true;
  for (const key of Object.keys(desc)) {
    if (key !== "cases") {
      ok = false;
      pushViolation(
        ctx,
        [...path, key],
        "unknown-field",
        `unknown enum-descriptor key ${JSON.stringify(key)}`,
        "one of: cases",
        actualWire(desc[key]),
      );
    }
  }
  const casesRaw = desc["cases"];
  if (isAbsent(casesRaw)) {
    pushViolation(ctx, [...path, "cases"], "required", `enum ${name} is missing its cases`, "a nonempty case list");
    return null;
  }
  if (!Array.isArray(casesRaw)) {
    pushViolation(
      ctx,
      [...path, "cases"],
      "type",
      `enum ${name} cases must be an array`,
      "a nonempty case list",
      actualWire(casesRaw),
    );
    return null;
  }
  if (casesRaw.length === 0) {
    pushViolation(ctx, [...path, "cases"], "format", `enum ${name} needs at least one case`, "a nonempty case list");
    return null;
  }
  const cases: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < casesRaw.length; index += 1) {
    const entry: unknown = casesRaw[index];
    if (typeof entry !== "string") {
      ok = false;
      pushViolation(
        ctx,
        [...path, "cases", index],
        "type",
        `enum ${name} case must be a name`,
        "an unqualified name",
        actualWire(entry),
      );
      continue;
    }
    if (!NAME_RE.test(entry)) {
      ok = false;
      pushViolation(
        ctx,
        [...path, "cases", index],
        "format",
        `enum ${name} case ${JSON.stringify(entry)} is not a valid name`,
        "an unqualified name",
        actualWire(entry),
      );
      continue;
    }
    if (seen.has(entry)) {
      ok = false;
      pushViolation(
        ctx,
        [...path, "cases", index],
        "format",
        `enum ${name} repeats case ${JSON.stringify(entry)}`,
        "distinct cases",
        actualWire(entry),
      );
      continue;
    }
    seen.add(entry);
    cases.push(entry);
  }
  return ok ? cases : null;
}

interface PendingOperation {
  readonly inputs: Record<string, PendingField>;
  readonly mutation: boolean;
}

function freezeField(field: PendingField, fallback: CanValue | undefined): NormalizedField {
  if (field.hasDefault && fallback === undefined) {
    throw new ValueError("invalid-construction", "normalized field is missing its validated default");
  }
  const out: NormalizedField = {
    type: field.type,
    typeId: printTypeId(field.type),
    required: field.required,
    hasDefault: field.hasDefault,
    ...(field.lengthMin !== undefined ? { lengthMin: field.lengthMin } : {}),
    ...(field.lengthMax !== undefined ? { lengthMax: field.lengthMax } : {}),
    ...(field.valueMin !== undefined ? { valueMin: field.valueMin } : {}),
    ...(field.valueMax !== undefined ? { valueMax: field.valueMax } : {}),
    ...(field.hasDefault && fallback !== undefined ? { default: fallback } : {}),
    ...(field.trim !== undefined ? { trim: field.trim } : {}),
    serverOnly: field.serverOnly,
    ...(field.defaultOrigin !== undefined ? { defaultOrigin: field.defaultOrigin } : {}),
  };
  return Object.freeze(out);
}

/**
 * Validates a schema descriptor into a frozen NormalizedSchema. Unknown
 * keys, bad names, bad type ids, incompatible bounds, and invalid defaults
 * all throw one SchemaError with every collected violation.
 */
export function normalizeSchema(descriptor: unknown): NormalizedSchema {
  const ctx: Collector = { violations: [] };
  if (!isObject(descriptor)) {
    pushViolation(
      ctx,
      [],
      "type",
      "schema descriptor must be an object",
      "{contracts?, enums?, operations?}",
      actualWire(descriptor),
    );
    throw new SchemaError(ctx.violations);
  }
  for (const key of Object.keys(descriptor)) {
    if (key !== "contracts" && key !== "enums" && key !== "operations") {
      pushViolation(
        ctx,
        [key],
        "unknown-field",
        `unknown schema section ${JSON.stringify(key)}`,
        "one of: contracts, enums, operations",
        actualWire(descriptor[key]),
      );
    }
  }
  const contracts: Record<string, Record<string, PendingField>> = {};
  const enums: Record<string, { readonly cases: readonly string[] }> = {};
  const operations: Record<string, PendingOperation> = {};

  const contractsRaw = descriptor["contracts"];
  if (!isAbsent(contractsRaw)) {
    if (!isObject(contractsRaw)) {
      pushViolation(ctx, ["contracts"], "type", "contracts must be an object", "{name: {...}}", actualWire(contractsRaw));
    } else {
      for (const [name, def] of Object.entries(contractsRaw)) {
        if (isReservedName(name)) {
          pushViolation(
            ctx,
            ["contracts", name],
            "format",
            `contract name "__proto__" is reserved`,
            "any other contract name",
            actualWire(name),
          );
          continue;
        }
        if (!PATH_RE.test(name)) {
          pushViolation(
            ctx,
            ["contracts", name],
            "format",
            `contract name ${JSON.stringify(name)} is not a valid path`,
            "a dotted type path",
            actualWire(name),
          );
          continue;
        }
        if (!isObject(def)) {
          pushViolation(
            ctx,
            ["contracts", name],
            "type",
            `contract ${name} descriptor must be an object`,
            "{fields: {...}}",
            actualWire(def),
          );
          continue;
        }
        for (const key of Object.keys(def)) {
          if (key !== "fields") {
            pushViolation(
              ctx,
              ["contracts", name, key],
              "unknown-field",
              `unknown contract-descriptor key ${JSON.stringify(key)}`,
              "one of: fields",
              actualWire(def[key]),
            );
          }
        }
        const fieldsRaw = def["fields"];
        if (isAbsent(fieldsRaw)) {
          pushViolation(
            ctx,
            ["contracts", name, "fields"],
            "required",
            `contract ${name} is missing its fields`,
            "{name: {...}}",
          );
          continue;
        }
        if (!isObject(fieldsRaw)) {
          pushViolation(
            ctx,
            ["contracts", name, "fields"],
            "type",
            `contract ${name} fields must be an object`,
            "{name: {...}}",
            actualWire(fieldsRaw),
          );
          continue;
        }
        const fields: Record<string, PendingField> = {};
        for (const [fieldName, fieldDesc] of Object.entries(fieldsRaw)) {
          if (isReservedName(fieldName)) {
            pushViolation(
              ctx,
              ["contracts", name, "fields", fieldName],
              "format",
              `field name "__proto__" is reserved`,
              "any other field name",
              actualWire(fieldName),
            );
            continue;
          }
          if (!NAME_RE.test(fieldName)) {
            pushViolation(
              ctx,
              ["contracts", name, "fields", fieldName],
              "format",
              `field name ${JSON.stringify(fieldName)} is not a valid name`,
              "an unqualified name",
              actualWire(fieldName),
            );
            continue;
          }
          const field = normalizeField(fieldDesc, ["contracts", name, "fields", fieldName], ctx, true, true);
          if (field !== null) {
            fields[fieldName] = field;
          }
        }
        contracts[name] = fields;
      }
    }
  }

  const enumsRaw = descriptor["enums"];
  if (!isAbsent(enumsRaw)) {
    if (!isObject(enumsRaw)) {
      pushViolation(ctx, ["enums"], "type", "enums must be an object", "{name: {...}}", actualWire(enumsRaw));
    } else {
      for (const [name, def] of Object.entries(enumsRaw)) {
        if (isReservedName(name)) {
          pushViolation(
            ctx,
            ["enums", name],
            "format",
            `enum name "__proto__" is reserved`,
            "any other enum name",
            actualWire(name),
          );
          continue;
        }
        if (!PATH_RE.test(name)) {
          pushViolation(
            ctx,
            ["enums", name],
            "format",
            `enum name ${JSON.stringify(name)} is not a valid path`,
            "a dotted type path",
            actualWire(name),
          );
          continue;
        }
        const cases = normalizeEnumCases(def, name, ["enums", name], ctx);
        if (cases !== null) {
          enums[name] = { cases };
        }
      }
    }
  }

  const operationsRaw = descriptor["operations"];
  if (!isAbsent(operationsRaw)) {
    if (!isObject(operationsRaw)) {
      pushViolation(
        ctx,
        ["operations"],
        "type",
        "operations must be an object",
        "{name: {...}}",
        actualWire(operationsRaw),
      );
    } else {
      for (const [name, def] of Object.entries(operationsRaw)) {
        if (isReservedName(name)) {
          pushViolation(
            ctx,
            ["operations", name],
            "format",
            `operation name "__proto__" is reserved`,
            "any other operation name",
            actualWire(name),
          );
          continue;
        }
        if (!PATH_RE.test(name)) {
          pushViolation(
            ctx,
            ["operations", name],
            "format",
            `operation name ${JSON.stringify(name)} is not a valid path`,
            "a dotted type path",
            actualWire(name),
          );
          continue;
        }
        if (!isObject(def)) {
          pushViolation(
            ctx,
            ["operations", name],
            "type",
            `operation ${name} descriptor must be an object`,
            "{inputs: {...}, mutation?}",
            actualWire(def),
          );
          continue;
        }
        for (const key of Object.keys(def)) {
          if (key !== "inputs" && key !== "mutation") {
            pushViolation(
              ctx,
              ["operations", name, key],
              "unknown-field",
              `unknown operation-descriptor key ${JSON.stringify(key)}`,
              "one of: inputs, mutation",
              actualWire(def[key]),
            );
          }
        }
        let mutation = false;
        const mutationRaw = def["mutation"];
        if (!isAbsent(mutationRaw)) {
          if (typeof mutationRaw !== "boolean") {
            pushViolation(
              ctx,
              ["operations", name, "mutation"],
              "type",
              `operation ${name} mutation must be a boolean`,
              "a boolean",
              actualWire(mutationRaw),
            );
            continue;
          }
          mutation = mutationRaw;
        }
        const inputsRaw = def["inputs"];
        if (isAbsent(inputsRaw)) {
          pushViolation(
            ctx,
            ["operations", name, "inputs"],
            "required",
            `operation ${name} is missing its inputs`,
            "{name: {...}}",
          );
          continue;
        }
        if (!isObject(inputsRaw)) {
          pushViolation(
            ctx,
            ["operations", name, "inputs"],
            "type",
            `operation ${name} inputs must be an object`,
            "{name: {...}}",
            actualWire(inputsRaw),
          );
          continue;
        }
        const inputs: Record<string, PendingField> = {};
        for (const [inputName, inputDesc] of Object.entries(inputsRaw)) {
          if (inputName === "operation_id") {
            pushViolation(
              ctx,
              ["operations", name, "inputs", inputName],
              "format",
              "operation_id is reserved and cannot be a declared input",
              "any other input name",
              actualWire(inputName),
            );
            continue;
          }
          if (isReservedName(inputName)) {
            pushViolation(
              ctx,
              ["operations", name, "inputs", inputName],
              "format",
              `input name "__proto__" is reserved`,
              "any other input name",
              actualWire(inputName),
            );
            continue;
          }
          if (!NAME_RE.test(inputName)) {
            pushViolation(
              ctx,
              ["operations", name, "inputs", inputName],
              "format",
              `input name ${JSON.stringify(inputName)} is not a valid name`,
              "an unqualified name",
              actualWire(inputName),
            );
            continue;
          }
          const field = normalizeField(inputDesc, ["operations", name, "inputs", inputName], ctx, false, false);
          if (field !== null) {
            inputs[inputName] = field;
          }
        }
        operations[name] = { inputs, mutation };
      }
    }
  }

  for (const name of Object.keys(contracts)) {
    if (Object.hasOwn(enums, name)) {
      pushViolation(
        ctx,
        ["enums", name],
        "type",
        `${JSON.stringify(name)} is declared as both a contract and an enum`,
        "a name in exactly one of contracts, enums",
        actualWire(name),
      );
    }
  }
  if (ctx.violations.length > 0) {
    throw new SchemaError(ctx.violations);
  }

  // Pass 2: descriptor defaults must be explicit-complete values.
  const viewContracts: Record<string, { readonly fields: Record<string, PendingField> }> = {};
  for (const [name, fields] of Object.entries(contracts)) {
    viewContracts[name] = { fields };
  }
  const view: SchemaView = { contracts: viewContracts, enums };
  const defaults = new Map<PendingField, CanValue>();
  const pendingDefaults: Array<{ readonly field: PendingField; readonly path: Path }> = [];
  for (const [name, fields] of Object.entries(contracts)) {
    for (const [fieldName, field] of Object.entries(fields)) {
      if (field.hasDefault) {
        pendingDefaults.push({ field, path: ["contracts", name, "fields", fieldName, "default"] });
      }
    }
  }
  for (const [name, op] of Object.entries(operations)) {
    for (const [inputName, field] of Object.entries(op.inputs)) {
      if (field.hasDefault) {
        pendingDefaults.push({ field, path: ["operations", name, "inputs", inputName, "default"] });
      }
    }
  }
  for (const { field, path } of pendingDefaults) {
    const before = ctx.violations.length;
    const raw = validateNode(
      view,
      field.type,
      field.rawDefault,
      path,
      ctx,
      { nesting: "explicit", requireVersion: false },
    );
    if (raw === FAIL || raw === UPDATE_OMITTED) {
      continue;
    }
    if (ctx.violations.length !== before) {
      continue;
    }
    // Explicit defaults normalize before their bound check, like inputs.
    const decoded = applyTrim(field, raw);
    if (decoded !== null && hasBounds(field)) {
      checkBounds(field, decoded as CanValue, path, ctx);
      if (ctx.violations.length !== before) {
        continue;
      }
    }
    defaults.set(field, decoded as CanValue);
  }
  if (ctx.violations.length > 0) {
    throw new SchemaError(ctx.violations);
  }

  const frozenContracts: Record<string, NormalizedContract> = {};
  for (const [name, fields] of Object.entries(contracts)) {
    const frozenFields: Record<string, NormalizedField> = {};
    for (const [fieldName, field] of Object.entries(fields)) {
      frozenFields[fieldName] = freezeField(field, defaults.get(field));
    }
    frozenContracts[name] = Object.freeze({ fields: Object.freeze(frozenFields) });
  }
  const frozenEnums: Record<string, NormalizedEnum> = {};
  for (const [name, enumeration] of Object.entries(enums)) {
    frozenEnums[name] = Object.freeze({ cases: Object.freeze([...enumeration.cases]) });
  }
  const frozenOperations: Record<string, NormalizedOperation> = {};
  for (const [name, op] of Object.entries(operations)) {
    const frozenInputs: Record<string, NormalizedField> = {};
    for (const [inputName, field] of Object.entries(op.inputs)) {
      frozenInputs[inputName] = freezeField(field, defaults.get(field));
    }
    frozenOperations[name] = Object.freeze({ inputs: Object.freeze(frozenInputs), mutation: op.mutation });
  }
  return Object.freeze({
    kind: "normalized-schema",
    contracts: Object.freeze(frozenContracts),
    enums: Object.freeze(frozenEnums),
    operations: Object.freeze(frozenOperations),
  });
}

// ---------------------------------------------------------------------------
// Public validation entry points.
// ---------------------------------------------------------------------------

/**
 * Validates wire data against a type id: closed contracts, inclusive
 * bounds, create-only defaults, and required-vs-nullable presence. Any
 * violation throws SchemaError (never a partial value). Create mode drops
 * omitted engine-resolved (`server`/`derived`) keys from the output (the
 * T18 engine supplies them). Update mode yields UPDATE_OMITTED for omitted
 * contract fields, never null.
 */
export function validateValue(
  schema: NormalizedSchema,
  typeId: string,
  wire: unknown,
  mode: "create",
): CanValue;
export function validateValue(
  schema: NormalizedSchema,
  typeId: string,
  wire: unknown,
  mode: "update",
): CanValue | UpdateContract;
export function validateValue(
  schema: NormalizedSchema,
  typeId: string,
  wire: unknown,
  mode: ValidationMode,
): CanValue | UpdateContract {
  assertNormalizedSchema(schema);
  if (mode !== "create" && mode !== "update") {
    throw new ValueError("invalid-construction", 'validation mode must be "create" or "update"');
  }
  const ast = parseTypeId(typeId);
  const ctx: Collector = { violations: [] };
  const options: NodeOptions =
    mode === "create" ? { nesting: "create", requireVersion: false } : { nesting: "update", requireVersion: false };
  const out = validateNode(schema, ast, wire, [], ctx, options);
  if (out === FAIL || ctx.violations.length > 0) {
    throw new SchemaError(ctx.violations);
  }
  return out as CanValue | UpdateContract;
}

/**
 * Validates an operation's argument object: unknown arguments fail,
 * mutations require a non-empty text `operation_id` and an expected
 * version on every model ref, queries preserve versions without
 * requiring them. Returns the frozen validated arguments.
 */
export function validateOperationInput(
  schema: NormalizedSchema,
  opName: string,
  args: unknown,
): ContractValue {
  assertNormalizedSchema(schema);
  if (typeof opName !== "string" || opName.length === 0) {
    throw new ValueError("invalid-construction", "operation name must be a non-empty string");
  }
  const op = schema.operations[opName];
  if (op === undefined) {
    throw new ValueError("invalid-construction", `unknown operation ${JSON.stringify(opName)}`);
  }
  const ctx: Collector = { violations: [] };
  if (!isObject(args)) {
    pushViolation(
      ctx,
      [],
      "type",
      `operation ${opName} expects an argument object`,
      `inputs for ${opName}`,
      actualWire(args),
    );
    throw new SchemaError(ctx.violations);
  }
  const declared = Object.keys(op.inputs);
  const known = new Set(declared);
  const expectedArgs =
    declared.length === 0 && !op.mutation
      ? "no declared arguments"
      : `one of: ${[...declared, ...(op.mutation ? ["operation_id"] : [])].join(", ")}`;
  let ok = true;
  for (const key of Object.keys(args)) {
    if (args[key] === undefined) {
      continue;
    }
    if (key === "operation_id" && op.mutation) {
      continue;
    }
    if (!known.has(key)) {
      ok = false;
      pushViolation(
        ctx,
        [key],
        "unknown-argument",
        `operation ${opName} has no argument ${JSON.stringify(key)}`,
        expectedArgs,
        actualWire(args[key]),
      );
    }
  }
  const options: NodeOptions = { nesting: "create", requireVersion: op.mutation };
  const out: Record<string, CanValue> = {};
  for (const [name, field] of Object.entries(op.inputs)) {
    const raw = Object.hasOwn(args, name) ? args[name] : undefined;
    if (raw === undefined) {
      const omitted = omittedField(field, [name], ctx, options);
      if (omitted === FAIL) {
        ok = false;
      } else if (!isEngineResolved(omitted)) {
        out[name] = omitted as CanValue;
      }
      continue;
    }
    const before = ctx.violations.length;
    const decoded = validateNode(schema, field.type, raw, [name], ctx, options);
    if (decoded === FAIL) {
      ok = false;
      continue;
    }
    const stored = applyTrim(field, decoded);
    out[name] = stored as CanValue;
    if (hasBounds(field) && ctx.violations.length === before && stored !== null) {
      checkBounds(field, stored as CanValue, [name], ctx);
      if (ctx.violations.length !== before) {
        ok = false;
      }
    }
  }
  if (op.mutation) {
    const rawId = Object.hasOwn(args, "operation_id") ? args["operation_id"] : undefined;
    if (rawId === undefined) {
      ok = false;
      pushViolation(ctx, ["operation_id"], "required", `mutation ${opName} requires operation_id`, "non-empty text");
    } else if (typeof rawId !== "string") {
      ok = false;
      pushViolation(
        ctx,
        ["operation_id"],
        "type",
        "operation_id must be text",
        "non-empty text",
        actualWire(rawId),
      );
    } else if (rawId.length === 0) {
      ok = false;
      pushViolation(
        ctx,
        ["operation_id"],
        "format",
        "operation_id must be non-empty",
        "non-empty text",
        actualWire(rawId),
      );
    } else {
      out["operation_id"] = rawId;
    }
  }
  if (!ok || ctx.violations.length > 0) {
    throw new SchemaError(ctx.violations);
  }
  return Object.freeze(out);
}
