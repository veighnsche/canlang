/**
 * Lane 02 structural equality: typed `equalValue` plus reference `same`.
 *
 * Normative: DESIGN.md L159 (null rules), L205-209 (equality/matrix; typed
 * structural equality; refs by identity), L992 (`equalValue`/`same` lowering
 * contracts); lane-02 decisions R1 (runtime tags), R2c (money `==` decidable
 * across currencies, unequal) and R3 (decimal value equality; `same` ignores
 * versions).
 *
 * Lane-03 boundary: this module compares supplied values only. Record-query
 * evaluation (query-fed aggregates, stable ordering proofs, authorization)
 * is lane 03's; nothing here reads records, queries, or invocation context.
 *
 * Decisions recorded here (no normative text found):
 * - Pure-core signature is `equalValue(typeId, a, b)`. The `c`-first shape in
 *   DESIGN L992 is the generated-code call form; the pure core takes no
 *   context and generated shims drop `c` before calling it.
 * - Without owning schema context only trailing `?` nullability
 *   and trailing `[]` array suffixes are stripped; every other type id is an
 *   opaque label and dispatch is by runtime kind. With owning schema, declared
 *   Contract fields and union arms dispatch recursively by their declared types.
 *   An empty type id means pure runtime dispatch (used by `group` key matching in array.ts).
 * - `same()` on mismatched ref kinds returns false (unequal), never throws;
 *   only non-ref inputs throw `invalid-construction`.
 * - `same()` identity: RecordRef = model+id (version ignored: concurrency,
 *   not identity); UserRef/MemberRef/FileValue/DeliveryRef = id only;
 *   ActionRef = target plus bindings identity (it carries no id field);
 *   InvocationRef = target plus structural arg equality (args are decoded
 *   values with no declared types, so per-arg comparison is structural via
 *   `equalNested`; nested refs compare by identity, versions ignored).
 * - Secret values are NEVER equal unless identically referenced (`a === b`);
 *   two distinct secret objects compare false, secret vs non-secret throws.
 * - bigint/Decimal mixes promote exactly via `compareDecimal` (DESIGN L209
 *   int/decimal promotion inside the operator).
 * - Contract field order is irrelevant (key-set plus fieldwise comparison);
 *   a missing key vs a present-but-undefined key is unequal (false), while a
 *   present-but-undefined value compared against anything is
 *   `invalid-construction` (undefined is not a CanValue).
 * - Objects carrying a known value-tag `kind` that fail their shape guard
 *   are malformed values (`invalid-construction`) outside declared Contract
 *   positions; objects
 *   with an unknown or non-string `kind` compare as plain contracts.
 * - Non-array values under an array type id, and mismatched runtime kinds
 *   (except the decidable money/secret/ref cases above), are
 *   `invalid-construction`: the checker guarantees homogeneous typed inputs.
 */

import type {
  ActionRef,
  CanValue,
  DeliveryRef,
  FileValue,
  InvocationRef,
  MemberRef,
  RecordRef,
  SecretValue,
  UserRef,
} from "@canlang/contracts/values";
import type { NormalizedSchema } from "./schema.js";
import { parseTypeId } from "./types.js";
import { compareDecimal, isDecimal } from "./decimal.js";
import { ValueError } from "./errors.js";
import {
  isActionRef,
  isDateValue,
  isDatetime,
  isDeliveryRef,
  isFileValue,
  isInvocationRef,
  isMemberRef,
  isMoney,
  isRecordRef,
  isUnionValue,
  isUserRef,
} from "./kinds.js";
import { equalMoney } from "./money.js";
import { compareDate, compareInstant } from "./temporal.js";

type RecordReferenceResolver = (value: CanValue) => RecordRef | undefined;

type RefKind = "user" | "member" | "ref" | "file" | "delivery" | "action" | "invocation";

/** Classifies well-formed refs; malformed or non-ref values yield null. */
function refKindOf(value: CanValue): RefKind | null {
  if (isUserRef(value)) return "user";
  if (isMemberRef(value)) return "member";
  if (isRecordRef(value)) return "ref";
  if (isFileValue(value)) return "file";
  if (isDeliveryRef(value)) return "delivery";
  if (isActionRef(value)) return "action";
  if (isInvocationRef(value)) return "invocation";
  return null;
}

function isSecretValue(value: CanValue): value is SecretValue {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)["kind"] === "secret"
  );
}

/** Value tags whose shape is owned elsewhere; malformed carriers are errors. */
const KNOWN_VALUE_KINDS: ReadonlySet<string> = new Set([
  "decimal",
  "money",
  "date",
  "datetime",
  "user",
  "member",
  "ref",
  "union",
  "action",
  "invocation",
  "delivery",
  "file",
  "secret",
]);

function hasKnownKindTag(value: object): boolean {
  const kind = (value as Record<string, unknown>)["kind"];
  return typeof kind === "string" && KNOWN_VALUE_KINDS.has(kind);
}

/**
 * Reference identity (`same`, DESIGN L992). Refs only: record model+id,
 * user/member/file/delivery id, action target+bindings identity,
 * invocation target+structural-arg identity. Versions are concurrency
 * stamps, not identity, and are ignored. Mismatched ref kinds are
 * unequal (false); non-ref inputs are `invalid-construction`.
 */
export function same(a: CanValue, b: CanValue): boolean {
  return sameReferences(a, b);
}

/** Keywise entry comparison for action bindings and invocation args. */
function sameKeyedEntries(
  keysLeft: readonly string[],
  keysRight: readonly string[],
  getLeft: (key: string) => CanValue | undefined,
  getRight: (key: string) => CanValue | undefined,
  sameEntry: (left: CanValue, right: CanValue) => boolean,
): boolean {
  if (keysLeft.length !== keysRight.length) {
    return false;
  }
  for (const key of keysLeft) {
    const entryLeft = getLeft(key);
    const entryRight = getRight(key);
    if (entryLeft === undefined || entryRight === undefined) {
      return false;
    }
    if (!sameEntry(entryLeft, entryRight)) {
      return false;
    }
  }
  return true;
}

function sameActionReferences(
  left: ActionRef,
  right: ActionRef,
  resolveReference: RecordReferenceResolver | undefined,
): boolean {
  if (left.target !== right.target) {
    return false;
  }
  return sameKeyedEntries(
    Object.keys(left.bindings),
    Object.keys(right.bindings),
    (key) => left.bindings[key],
    (key) => right.bindings[key],
    (entryLeft, entryRight) => sameReferences(entryLeft, entryRight, resolveReference),
  );
}

function sameInvocationReferences(
  left: InvocationRef,
  right: InvocationRef,
  resolveReference: RecordReferenceResolver | undefined,
): boolean {
  if (left.target !== right.target) {
    return false;
  }
  return sameKeyedEntries(
    Object.keys(left.args),
    Object.keys(right.args),
    (key) => left.args[key],
    (key) => right.args[key],
    (argLeft, argRight) => equalNested(argLeft, argRight, resolveReference),
  );
}

function sameReferences(a: CanValue, b: CanValue, resolveReference?: RecordReferenceResolver): boolean {
  const kindA = refKindOf(a);
  const kindB = refKindOf(b);
  if (kindA === null || kindB === null) {
    throw new ValueError("invalid-construction", "same() compares reference values only");
  }
  if (kindA !== kindB) {
    return false;
  }
  switch (kindA) {
    case "user":
      return (a as UserRef).id === (b as UserRef).id;
    case "member":
      return (a as MemberRef).id === (b as MemberRef).id;
    case "ref":
      return (a as RecordRef).model === (b as RecordRef).model && (a as RecordRef).id === (b as RecordRef).id;
    case "file":
      return (a as FileValue).id === (b as FileValue).id;
    case "delivery":
      return (a as DeliveryRef).id === (b as DeliveryRef).id;
    case "action":
      return sameActionReferences(a as ActionRef, b as ActionRef, resolveReference);
    case "invocation":
      return sameInvocationReferences(a as InvocationRef, b as InvocationRef, resolveReference);
  }
}

/** Null-safe structural comparison used for nested values. */
function equalNested(a: CanValue, b: CanValue, resolveReference?: RecordReferenceResolver): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return equalInner(a, b, resolveReference);
}

/**
 * Runtime-kind structural dispatch for two non-null values. Union branches
 * and money currencies are decidable value differences (false); malformed
 * values and mismatched runtime kinds are `invalid-construction`.
 */
/**
 * Primitive dispatch (bigint/string/boolean). Returns null when neither
 * side is primitive; mismatched primitives are `invalid-construction`.
 */
function equalPrimitive(a: CanValue, b: CanValue): boolean | null {
  if (typeof a === "bigint" || typeof b === "bigint") {
    if (typeof a === "bigint" && typeof b === "bigint") {
      return a === b;
    }
    if ((typeof a === "bigint" || isDecimal(a)) && (typeof b === "bigint" || isDecimal(b))) {
      return compareDecimal(a, b) === 0;
    }
    throw new ValueError("invalid-construction", "cannot compare an int with a non-numeric value");
  }
  if (typeof a === "string" || typeof b === "string") {
    if (typeof a === "string" && typeof b === "string") {
      return a === b;
    }
    throw new ValueError("invalid-construction", "cannot compare text with a non-text value");
  }
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (typeof a === "boolean" && typeof b === "boolean") {
      return a === b;
    }
    throw new ValueError("invalid-construction", "cannot compare a boolean with a non-boolean value");
  }
  return null;
}

/**
 * Numeric/date dispatch (decimal/money/date/datetime). Returns null when
 * neither side carries one of these kinds; mismatches throw.
 */
function equalNumericDate(a: CanValue, b: CanValue): boolean | null {
  if (isDecimal(a) || isDecimal(b)) {
    if (isDecimal(a) && isDecimal(b)) {
      return compareDecimal(a, b) === 0;
    }
    throw new ValueError("invalid-construction", "cannot compare a decimal with a non-numeric value");
  }
  if (isMoney(a) || isMoney(b)) {
    if (isMoney(a) && isMoney(b)) {
      return equalMoney(a, b);
    }
    throw new ValueError("invalid-construction", "cannot compare money with a non-money value");
  }
  if (isDateValue(a) || isDateValue(b)) {
    if (isDateValue(a) && isDateValue(b)) {
      return compareDate(a, b) === 0;
    }
    throw new ValueError("invalid-construction", "cannot compare a date with a non-date value");
  }
  if (isDatetime(a) || isDatetime(b)) {
    if (isDatetime(a) && isDatetime(b)) {
      return compareInstant(a, b) === 0;
    }
    throw new ValueError("invalid-construction", "cannot compare a datetime with a non-datetime value");
  }
  return null;
}

function equalArrayValues(a: CanValue[], b: CanValue[], resolveReference?: RecordReferenceResolver): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    const itemA: CanValue | undefined = a[index] as CanValue | undefined;
    const itemB: CanValue | undefined = b[index] as CanValue | undefined;
    if (itemA === undefined || itemB === undefined) {
      throw new ValueError("invalid-construction", "array elements must be Can values");
    }
    if (!equalNested(itemA, itemB, resolveReference)) {
      return false;
    }
  }
  return true;
}

function equalRecordValues(
  recordA: Record<string, CanValue>,
  recordB: Record<string, CanValue>,
  resolveReference?: RecordReferenceResolver,
): boolean {
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (!Object.hasOwn(recordB, key)) {
      return false;
    }
    const fieldA = recordA[key];
    const fieldB = recordB[key];
    if (fieldA === undefined || fieldB === undefined) {
      throw new ValueError("invalid-construction", "contract fields must be Can values");
    }
    if (!equalNested(fieldA, fieldB, resolveReference)) {
      return false;
    }
  }
  return true;
}

function equalInner(a: CanValue, b: CanValue, resolveReference?: RecordReferenceResolver): boolean {
  // Resolve only a value demanded by the original recursive comparison. The
  // host supplies private identity metadata, never row reads or permissions.
  if (resolveReference !== undefined) {
    a = resolveReference(a) ?? a;
    b = resolveReference(b) ?? b;
  }
  const primitive = equalPrimitive(a, b);
  if (primitive !== null) {
    return primitive;
  }
  const numericDate = equalNumericDate(a, b);
  if (numericDate !== null) {
    return numericDate;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      throw new ValueError("invalid-construction", "cannot compare an array with a non-array value");
    }
    return equalArrayValues(a, b, resolveReference);
  }
  if (isUnionValue(a) || isUnionValue(b)) {
    if (!isUnionValue(a) || !isUnionValue(b)) {
      throw new ValueError("invalid-construction", "cannot compare a union with a non-union value");
    }
    return a.type === b.type && equalNested(a.value, b.value, resolveReference);
  }
  const refA = refKindOf(a);
  const refB = refKindOf(b);
  if (refA !== null || refB !== null) {
    if (refA === null || refB === null) {
      throw new ValueError("invalid-construction", "cannot compare a reference with a non-reference value");
    }
    return sameReferences(a, b, resolveReference);
  }
  return equalTaggedOrRecord(a, b, resolveReference);
}

/** Secret/record dispatch for two non-union, non-reference values. */
function equalTaggedOrRecord(a: CanValue, b: CanValue, resolveReference?: RecordReferenceResolver): boolean {
  if (isSecretValue(a) || isSecretValue(b)) {
    if (!isSecretValue(a) || !isSecretValue(b)) {
      throw new ValueError("invalid-construction", "cannot compare a secret with a non-secret value");
    }
    return a === b;
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    if (hasKnownKindTag(a) || hasKnownKindTag(b)) {
      throw new ValueError("invalid-construction", "malformed tagged value");
    }
    return equalRecordValues(a as Record<string, CanValue>, b as Record<string, CanValue>, resolveReference);
  }
  throw new ValueError("invalid-construction", "cannot compare these values");
}

/**
 * Typed structural equality (DESIGN L992 `equalValue` core). Strips trailing
 * `?` (null equals null, null vs value is false) and trailing `[]` (ordered
 * elementwise recursion), then dispatches on runtime kind: bigints, strings
 * and booleans by `===`; decimals by value across scales; money by
 * `equalMoney` (cross-currency is unequal, never an error); dates/datetimes
 * by their comparators; arrays ordered elementwise; contracts fieldwise;
 * unions by branch plus value; refs by `same` identity; files by id; actions
 * by target plus bindings identity; invocations by target plus structural
 * arg equality; secrets by identical reference only. An optional host resolver
 * supplies original record identities only at demanded comparison values;
 * omitting it retains the canonical pure behavior and short-circuit order.
 * An owning schema identifies declared Contract containers before runtime tags;
 * their fields recurse by declaration, including business kind/id/version keys.
 */
/** Ordered elementwise recursion for `T[]` values; both sides are arrays. */
function equalTypedArrays(
  element: string,
  a: CanValue[],
  b: CanValue[],
  resolveReference: RecordReferenceResolver | undefined,
  schema: NormalizedSchema | undefined,
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    const itemA: CanValue | undefined = a[index] as CanValue | undefined;
    const itemB: CanValue | undefined = b[index] as CanValue | undefined;
    if (itemA === undefined || itemB === undefined) {
      throw new ValueError("invalid-construction", "array elements must be Can values");
    }
    if (!equalValue(element, itemA, itemB, resolveReference, schema)) {
      return false;
    }
  }
  return true;
}

/** Fieldwise recursion for declared contract containers. */
function equalContractFields(
  base: string,
  contract: { readonly fields: Record<string, { readonly typeId: string }> },
  a: Record<string, CanValue>,
  b: Record<string, CanValue>,
  resolveReference: RecordReferenceResolver | undefined,
  schema: NormalizedSchema | undefined,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) return false;
    const field = Object.hasOwn(contract.fields, key) ? contract.fields[key] : undefined;
    if (field === undefined) {
      throw new ValueError("invalid-construction", `unknown ${base} contract field ${key}`);
    }
    const fieldA = a[key];
    const fieldB = b[key];
    if (fieldA === undefined || fieldB === undefined) {
      throw new ValueError("invalid-construction", "contract fields must be Can values");
    }
    if (!equalValue(field.typeId, fieldA, fieldB, resolveReference, schema)) return false;
  }
  return true;
}

/** Union dispatch against the declared arms. */
function equalDeclaredUnion(
  ast: ReturnType<typeof parseTypeId>,
  a: CanValue,
  b: CanValue,
  resolveReference: RecordReferenceResolver | undefined,
  schema: NormalizedSchema | undefined,
): boolean {
  if (ast.base.kind === "union") {
    if (!isUnionValue(a) || !isUnionValue(b)) {
      throw new ValueError("invalid-construction", "cannot compare a union with a non-union value");
    }
    if (a.type !== b.type) return false;
    if (!ast.base.arms.includes(a.type)) {
      throw new ValueError("invalid-construction", "union discriminator names no declared arm");
    }
    return equalValue(a.type, a.value, b.value, resolveReference, schema);
  }
  return equalInner(a, b, resolveReference);
}

/** Strip trailing `?`/`[]` markers into the base id, element id and array depth. */
function parseEqualValueShape(typeId: string): { base: string; element: string; depth: number } {
  let base = typeId;
  while (base.endsWith("?")) {
    base = base.slice(0, -1);
  }
  return { base, element: base, depth: 0 };
}

export function equalValue(typeId: string, a: CanValue, b: CanValue, resolveReference: RecordReferenceResolver | undefined = undefined, schema: NormalizedSchema | undefined = undefined): boolean {
  if (typeof typeId !== "string") {
    throw new ValueError("invalid-construction", "equalValue needs a canonical type id string");
  }
  if (a === null || b === null) {
    return a === b;
  }
  let { base, element, depth } = parseEqualValueShape(typeId);
  if (schema !== undefined && base.endsWith("[]!")) {
    base = base.slice(0, -1);
    element = element.slice(0, -1);
  }
  while (element.endsWith("[]")) {
    element = element.slice(0, -2);
    depth += 1;
  }
  if (depth > 0) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      throw new ValueError("invalid-construction", `equalValue: ${typeId} expects array values`);
    }
    return equalTypedArrays(element, a, b, resolveReference, schema);
  }
  if (schema !== undefined && base !== "") {
    const contract = Object.hasOwn(schema.contracts, base) ? schema.contracts[base] : undefined;
    if (contract !== undefined) {
      if (typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) {
        throw new ValueError("invalid-construction", `equalValue: ${typeId} expects contract values`);
      }
      return equalContractFields(base, contract, a as Record<string, CanValue>, b as Record<string, CanValue>, resolveReference, schema);
    }
    return equalDeclaredUnion(parseTypeId(base), a, b, resolveReference, schema);
  }
  return equalInner(a, b, resolveReference);
}
