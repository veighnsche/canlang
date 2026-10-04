/**
 * Lane 02 wire codec: exact `CanValue` <-> `WireValue` conversions per type id.
 *
 * Normative: DESIGN.md L872 (closed typed JSON objects; `{id}` reads vs
 * `{id,version}` mutations; canonical decimal strings for every int/decimal
 * including money.minor and record.version; RFC 3339 UTC datetimes;
 * discriminated unions), L147 (action bindings carry identity AND expected
 * version), L121 (union `{type,value}`; closed contracts); GRAMMAR.md L179
 * (union shape); values-20261004 JEV advice R2a (decimal wire form: strip
 * trailing fractional zeros, no point when integral, `0` for zero) and R2b
 * (currency admission is pinned-ISO-table membership).
 *
 * Pinned forms (every value has exactly one encoding; no Number routing):
 * - int: canonical decimal string, int64 range (leading zeros accepted on
 *   decode and normalized; `-0` decodes to 0).
 * - decimal: R2a normalized text via `decimalToString`; decode keeps the
 *   authored scale (like `parseDecimal`), so `decode(encode(x))` is
 *   value-equal and re-encoding is stable.
 * - money: `{minor, currency}` with exact keys; minor is a canonical int64
 *   string, currency a pinned ISO 4217 member.
 * - duration: canonical integer-millisecond decimal string, int64 range;
 *   decode rejects non-integers (`"1500.5"`, `"1s"`) as format violations.
 * - date: `YYYY-MM-DD`; datetime: RFC 3339 UTC always with `.sss` millis
 *   (`...T12:34:56.789Z`); decode accepts exactly that pinned form (offsets,
 *   missing millis, lowercase `t`/`z` are format violations).
 * - user/file: `{id}`; member: `{id, user: {id}, team}` (full, lossless);
 *   delivery: `{id, operation}` (a `delivery(Op)` type pins the operation);
 *   refs (nominal models): `{id}` reads / `{id, version}` mutations with
 *   version a canonical int64 string — decode accepts both shapes and
 *   preserves the version when present; schema-level operation validation
 *   enforces mutation presence (this module takes only a type id).
 * - union: `{type, value}` with `type` one of the id's arms.
 * - action: `{target, bindings: {name: {id, version}}}` with version
 *   REQUIRED on every binding; an `action(...)` type restricts the target.
 * - enum(a,b,...): the bare case string.
 * - secret: encode THROWS (never serialized); decode has no valid form.
 * - email/url: accepted as plain strings with NO format validation (no
 *   invented email/URL grammar — recorded here, not validated).
 * - locale: validated BCP 47, canonicalized on decode AND encode.
 * - timezone: validated pinned-zone membership (Intl/ICU), kept verbatim.
 * - currency: validated pinned-ISO-table membership.
 *
 * Boundaries recorded here:
 * - Violation codes: `type` = wrong JSON shape, `format` = right shape but
 *   bad content, `bound` = out of range, `required` = missing object key,
 *   `unknown-field` = extra object key. Malformed wire throws SchemaError
 *   (possibly with several violations); ValueError is reserved for caller
 *   errors (bad type id, encode/type mismatch, secret encode).
 * - Nominal paths decode by wire shape: `{id[,version]}`-shaped objects
 *   (any object carrying `id`) become model refs, other plain objects
 *   become structural contract values (JSON-native leaves; numbers are
 *   rejected — exact-scalar leaves need `schema.validateValue` with field
 *   types), and strings pass through (the named-enum path; membership is
 *   enforced by `schema.validateValue`). A nominal contract object that
 *   carries an `id` key therefore needs schema validation; consequences
 *   are asserted in the tests.
 * - Contract closedness (unknown-field rejection against DECLARED fields)
 *   lives in schema.ts, which knows the declarations; this module enforces
 *   exact key sets on every other object shape.
 * - Action binding wire has no model slot, so decode records the binding
 *   (parameter) name as `RecordRef.model`; the canonical parameter->model
 *   mapping is registry knowledge (checker/lane-01), and encode drops the
 *   model. Round-trips are exact on the wire shape.
 * - `[]!` behaves exactly like `[]` here (creation metadata, schema-owned).
 * - `undefined` is asymmetric by design: object keys with `undefined`
 *   values are leniently absent (matches `readKey`; JSON has no
 *   undefined), while array elements must be present values — dropping
 *   an element would shift indices, so `decodeDynamic` on `[undefined]`
 *   fails with a `type` violation instead of shrinking the array.
 * - All outputs (values and wire) are frozen.
 */

import type {
  ActionRef,
  CanValue,
  DeliveryRef,
  RecordRef,
  UnionValue,
  Violation,
  ViolationCode,
  WireValue,
} from "../../contracts/src/values.js";
import { decimalToString, isDecimal, parseDecimal } from "./decimal.js";
import { SchemaError, ValueError } from "./errors.js";
import { INT64_MAX, INT64_MIN, int64 } from "./int.js";
import {
  isActionRef,
  isDateValue,
  isDatetime,
  isDeliveryRef,
  isFileValue,
  isMemberRef,
  isMoney,
  isRecordRef,
  isUnionValue,
  isUserRef,
  makeActionRef,
  makeDate,
  makeDatetime,
  makeDeliveryRef,
  makeFileValue,
  makeMemberRef,
  makeMoney,
  makeRecordRef,
  makeUnionValue,
  makeUserRef,
} from "./kinds.js";
import { canonicalLocale } from "./locale.js";
import { isKnownCurrency } from "./money.js";
import { assertDatetimeInRange, dateToEpochDays, epochDaysToDate } from "./temporal.js";
import { isTimezone } from "./timezone.js";
import {
  parseTypeId,
  printTypeId,
  type NormalizedType,
  type ScalarName,
  type StringLikeName,
  type TypeBase,
} from "./types.js";

type Path = ReadonlyArray<string | number>;

/** Internal decode failure marker; the violation is already recorded. */
const FAIL: unique symbol = Symbol("canlang.wire.decode-fail");

type DecodeOut = CanValue | typeof FAIL;

interface DecodeContext {
  readonly violations: Violation[];
}

function pushViolation(
  ctx: DecodeContext,
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Short stable description of unexpected wire for `actual` fields. */
function actualWire(wire: unknown): string {
  if (wire === null) {
    return "null";
  }
  switch (typeof wire) {
    case "string":
      return truncate(JSON.stringify(wire) as string, 64);
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

function isWireObject(wire: unknown): wire is Record<string, unknown> {
  return typeof wire === "object" && wire !== null && !Array.isArray(wire);
}

/**
 * Reads an object key where an `undefined` value counts as absent (JSON has
 * no undefined; lenient read keeps `{id, version: undefined}` a read shape).
 */
function readKey(wire: Record<string, unknown>, key: string): { readonly present: boolean; readonly value: unknown } {
  if (!Object.hasOwn(wire, key)) {
    return { present: false, value: undefined };
  }
  const value = wire[key];
  if (value === undefined) {
    return { present: false, value: undefined };
  }
  return { present: true, value };
}

function presentKeys(wire: Record<string, unknown>): string[] {
  return Object.keys(wire).filter((key) => wire[key] !== undefined);
}

/**
 * Exact-key-shape check: missing keys are `required` violations, extras are
 * `unknown-field`. Returns false when the shape is wrong (callers still
 * validate the present fields to accumulate precise leaf violations).
 */
function checkShape(
  ctx: DecodeContext,
  wire: Record<string, unknown>,
  path: Path,
  what: string,
  keys: ReadonlyArray<string>,
): boolean {
  let ok = true;
  for (const key of keys) {
    if (!readKey(wire, key).present) {
      ok = false;
      pushViolation(ctx, [...path, key], "required", `${what} is missing ${JSON.stringify(key)}`, what);
    }
  }
  const allowed = new Set(keys);
  for (const key of presentKeys(wire)) {
    if (!allowed.has(key)) {
      ok = false;
      pushViolation(
        ctx,
        [...path, key],
        "unknown-field",
        `${what} has no field ${JSON.stringify(key)}`,
        what,
        actualWire(wire[key]),
      );
    }
  }
  return ok;
}

function failType(
  ctx: DecodeContext,
  path: Path,
  what: string,
  expected: string,
  wire: unknown,
): typeof FAIL {
  pushViolation(ctx, path, "type", `${what} has the wrong wire type`, expected, actualWire(wire));
  return FAIL;
}

function failFormat(
  ctx: DecodeContext,
  path: Path,
  what: string,
  expected: string,
  wire: unknown,
): typeof FAIL {
  pushViolation(ctx, path, "format", `${what} is malformed`, expected, actualWire(wire));
  return FAIL;
}

function failBound(
  ctx: DecodeContext,
  path: Path,
  what: string,
  expected: string,
  wire: unknown,
): typeof FAIL {
  pushViolation(ctx, path, "bound", `${what} is out of range`, expected, actualWire(wire));
  return FAIL;
}

/** `$["a"][0]`-style path rendering for encode (caller-error) messages. */
function formatPath(path: Path): string {
  if (path.length === 0) {
    return "$";
  }
  return `$${path.map((seg) => (typeof seg === "number" ? `[${seg}]` : `[${JSON.stringify(seg)}]`)).join("")}`;
}

function encodeError(message: string, path: Path): ValueError {
  return new ValueError("invalid-construction", `${message} at ${formatPath(path)}`);
}

/** Freezes an array while keeping the mutable element type callers expect. */
function freezeArray<T>(items: T[]): T[] {
  return Object.freeze(items) as T[];
}

const INT_TEXT = /^-?\d+$/;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PINNED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const MS_PER_DAY = 86400000n;

/** Canonical int64 decimal string to bigint; failures are recorded, never thrown. */
function decodeInt64(
  ctx: DecodeContext,
  wire: unknown,
  path: Path,
  what: string,
  expected: string,
): bigint | typeof FAIL {
  if (typeof wire !== "string") {
    return failType(ctx, path, what, expected, wire);
  }
  if (!INT_TEXT.test(wire)) {
    return failFormat(ctx, path, what, expected, wire);
  }
  try {
    return int64(BigInt(wire));
  } catch (err) {
    if (!(err instanceof ValueError)) {
      throw err;
    }
    return failBound(ctx, path, what, `int in [${INT64_MIN}, ${INT64_MAX}]`, wire);
  }
}

function decodeDecimal(ctx: DecodeContext, wire: unknown, path: Path): DecodeOut {
  if (typeof wire !== "string") {
    return failType(ctx, path, "decimal", "canonical decimal string", wire);
  }
  try {
    return parseDecimal(wire);
  } catch (err) {
    if (!(err instanceof ValueError)) {
      throw err;
    }
    if (err.code === "invalid-construction") {
      return failFormat(ctx, path, "decimal", "canonical decimal string", wire);
    }
    return failBound(ctx, path, "decimal", "at most 38 significant digits and 18 fractional digits", wire);
  }
}

function decodeMoney(ctx: DecodeContext, wire: unknown, path: Path): DecodeOut {
  if (!isWireObject(wire)) {
    return failType(ctx, path, "money", "{minor, currency}", wire);
  }
  let ok = checkShape(ctx, wire, path, "money {minor, currency}", ["minor", "currency"]);
  let minor: bigint | typeof FAIL = FAIL;
  let currency = "";
  const minorRaw = readKey(wire, "minor");
  if (minorRaw.present) {
    const decoded = decodeInt64(ctx, minorRaw.value, [...path, "minor"], "money.minor", "canonical int64 string");
    if (decoded === FAIL) {
      ok = false;
    } else {
      minor = decoded;
    }
  }
  const currencyRaw = readKey(wire, "currency");
  if (currencyRaw.present) {
    const code = currencyRaw.value;
    if (typeof code !== "string") {
      ok = false;
      failType(ctx, [...path, "currency"], "money.currency", "ISO 4217 currency code", code);
    } else if (!isKnownCurrency(code)) {
      ok = false;
      failFormat(ctx, [...path, "currency"], "money.currency", "ISO 4217 currency code", code);
    } else {
      currency = code;
    }
  }
  if (!ok || minor === FAIL || currency === "") {
    return FAIL;
  }
  return makeMoney(minor, currency);
}

function decodeDate(ctx: DecodeContext, wire: unknown, path: Path): DecodeOut {
  if (typeof wire !== "string") {
    return failType(ctx, path, "date", "YYYY-MM-DD", wire);
  }
  const match = DATE_TEXT.exec(wire);
  if (match === null) {
    return failFormat(ctx, path, "date", "YYYY-MM-DD", wire);
  }
  const year = Number(match[1] as string);
  const month = Number(match[2] as string);
  const day = Number(match[3] as string);
  try {
    return makeDate(year, month, day);
  } catch (err) {
    if (!(err instanceof ValueError)) {
      throw err;
    }
    return failFormat(ctx, path, "date", "a real civil date in years 0001-9999", wire);
  }
}

function decodeDatetime(ctx: DecodeContext, wire: unknown, path: Path): DecodeOut {
  if (typeof wire !== "string") {
    return failType(ctx, path, "datetime", "RFC 3339 UTC with millis", wire);
  }
  const match = DATETIME_PINNED.exec(wire);
  if (match === null) {
    return failFormat(ctx, path, "datetime", "YYYY-MM-DDTHH:MM:SS.sssZ (UTC, millis required)", wire);
  }
  const year = Number(match[1] as string);
  const month = Number(match[2] as string);
  const day = Number(match[3] as string);
  const hour = Number(match[4] as string);
  const minute = Number(match[5] as string);
  const second = Number(match[6] as string);
  const milli = Number(match[7] as string);
  let days: number;
  try {
    days = dateToEpochDays(makeDate(year, month, day));
  } catch (err) {
    if (!(err instanceof ValueError)) {
      throw err;
    }
    return failFormat(ctx, path, "datetime", "a real UTC instant in years 0001-9999", wire);
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return failFormat(ctx, path, "datetime", "a real UTC instant in years 0001-9999", wire);
  }
  const ms = BigInt(days) * MS_PER_DAY + BigInt(hour * 3600000 + minute * 60000 + second * 1000 + milli);
  try {
    return makeDatetime(assertDatetimeInRange(ms));
  } catch (err) {
    if (!(err instanceof ValueError)) {
      throw err;
    }
    return failBound(ctx, path, "datetime", "an instant in years 0001-9999", wire);
  }
}

function decodeStringlike(
  ctx: DecodeContext,
  kind: "email" | "url" | "locale" | "timezone" | "currency",
  wire: unknown,
  path: Path,
): DecodeOut {
  if (typeof wire !== "string") {
    return failType(ctx, path, kind, "text", wire);
  }
  switch (kind) {
    case "email":
    case "url":
      return wire;
    case "locale":
      try {
        return canonicalLocale(wire);
      } catch (err) {
        if (!(err instanceof ValueError)) {
          throw err;
        }
        return failFormat(ctx, path, "locale", "canonical BCP 47 language tag", wire);
      }
    case "timezone":
      if (!isTimezone(wire)) {
        return failFormat(ctx, path, "timezone", "a known IANA zone identifier", wire);
      }
      return wire;
    case "currency":
      if (!isKnownCurrency(wire)) {
        return failFormat(ctx, path, "currency", "ISO 4217 currency code", wire);
      }
      return wire;
  }
}

/** Non-empty-string id field shared by user/file/ref shapes. */
function decodeIdField(
  ctx: DecodeContext,
  wire: Record<string, unknown>,
  path: Path,
  what: string,
  key: string,
): string | typeof FAIL {
  const raw = readKey(wire, key);
  if (!raw.present) {
    return FAIL;
  }
  if (typeof raw.value !== "string") {
    failType(ctx, [...path, key], `${what}.${key}`, "non-empty text", raw.value);
    return FAIL;
  }
  if (raw.value.length === 0) {
    failFormat(ctx, [...path, key], `${what}.${key}`, "non-empty text", raw.value);
    return FAIL;
  }
  return raw.value;
}

function decodeUser(ctx: DecodeContext, wire: unknown, path: Path): DecodeOut {
  if (!isWireObject(wire)) {
    return failType(ctx, path, "user", "{id}", wire);
  }
  const ok = checkShape(ctx, wire, path, "user {id}", ["id"]);
  const id = decodeIdField(ctx, wire, path, "user", "id");
  if (!ok || id === FAIL) {
    return FAIL;
  }
  return makeUserRef(id);
}

function decodeFile(ctx: DecodeContext, wire: unknown, path: Path): DecodeOut {
  if (!isWireObject(wire)) {
    return failType(ctx, path, "file", "{id}", wire);
  }
  const ok = checkShape(ctx, wire, path, "file {id}", ["id"]);
  const id = decodeIdField(ctx, wire, path, "file", "id");
  if (!ok || id === FAIL) {
    return FAIL;
  }
  return makeFileValue(id);
}

function decodeMember(ctx: DecodeContext, wire: unknown, path: Path): DecodeOut {
  if (!isWireObject(wire)) {
    return failType(ctx, path, "member", "{id, user, team}", wire);
  }
  let ok = checkShape(ctx, wire, path, "member {id, user, team}", ["id", "user", "team"]);
  const id = decodeIdField(ctx, wire, path, "member", "id");
  if (id === FAIL) {
    ok = false;
  }
  const team = decodeIdField(ctx, wire, path, "member", "team");
  if (team === FAIL) {
    ok = false;
  }
  let user: string | typeof FAIL = FAIL;
  const userRaw = readKey(wire, "user");
  if (userRaw.present) {
    const nested = userRaw.value;
    if (!isWireObject(nested)) {
      ok = false;
      failType(ctx, [...path, "user"], "member.user", "{id}", nested);
    } else {
      if (!checkShape(ctx, nested, [...path, "user"], "member.user {id}", ["id"])) {
        ok = false;
      }
      const nestedId = decodeIdField(ctx, nested, [...path, "user"], "member.user", "id");
      if (nestedId === FAIL) {
        ok = false;
      } else {
        user = nestedId;
      }
    }
  }
  if (!ok || id === FAIL || team === FAIL || user === FAIL) {
    return FAIL;
  }
  return makeMemberRef(id, makeUserRef(user), team);
}

function decodeDelivery(ctx: DecodeContext, operation: string | null, wire: unknown, path: Path): DecodeOut {
  if (!isWireObject(wire)) {
    return failType(ctx, path, "delivery", "{id, operation}", wire);
  }
  let ok = checkShape(ctx, wire, path, "delivery {id, operation}", ["id", "operation"]);
  const id = decodeIdField(ctx, wire, path, "delivery", "id");
  if (id === FAIL) {
    ok = false;
  }
  const op = decodeIdField(ctx, wire, path, "delivery", "operation");
  if (op === FAIL) {
    ok = false;
  } else if (operation !== null && op !== operation) {
    ok = false;
    pushViolation(
      ctx,
      [...path, "operation"],
      "format",
      "delivery is bound to a different operation",
      `operation "${operation}"`,
      actualWire(op),
    );
  }
  if (!ok || id === FAIL || op === FAIL) {
    return FAIL;
  }
  return makeDeliveryRef(id, op);
}

function decodeActionBinding(
  ctx: DecodeContext,
  name: string,
  wire: unknown,
  path: Path,
): RecordRef | typeof FAIL {
  if (!isWireObject(wire)) {
    failType(ctx, path, `action binding ${JSON.stringify(name)}`, "{id, version}", wire);
    return FAIL;
  }
  let ok = checkShape(ctx, wire, path, `action binding ${JSON.stringify(name)} {id, version}`, ["id", "version"]);
  const id = decodeIdField(ctx, wire, path, `action binding ${JSON.stringify(name)}`, "id");
  if (id === FAIL) {
    ok = false;
  }
  let version: bigint | typeof FAIL = FAIL;
  const versionRaw = readKey(wire, "version");
  if (versionRaw.present) {
    const decoded = decodeInt64(
      ctx,
      versionRaw.value,
      [...path, "version"],
      `action binding ${JSON.stringify(name)} version`,
      "canonical int64 string (expected version is required)",
    );
    if (decoded === FAIL) {
      ok = false;
    } else {
      version = decoded;
    }
  }
  if (!ok || id === FAIL || version === FAIL) {
    return FAIL;
  }
  return makeRecordRef(name, id, version);
}

function decodeAction(ctx: DecodeContext, targets: readonly string[] | null, wire: unknown, path: Path): DecodeOut {
  if (!isWireObject(wire)) {
    return failType(ctx, path, "action", "{target, bindings}", wire);
  }
  let ok = checkShape(ctx, wire, path, "action {target, bindings}", ["target", "bindings"]);
  const target = decodeIdField(ctx, wire, path, "action", "target");
  if (target === FAIL) {
    ok = false;
  } else if (targets !== null && !targets.includes(target)) {
    ok = false;
    pushViolation(
      ctx,
      [...path, "target"],
      "format",
      "action target is outside this type's allowlist",
      `one of: ${targets.join(", ")}`,
      actualWire(target),
    );
  }
  const bindings: Record<string, RecordRef> = {};
  const bindingsRaw = readKey(wire, "bindings");
  if (bindingsRaw.present) {
    const raw = bindingsRaw.value;
    if (!isWireObject(raw)) {
      ok = false;
      failType(ctx, [...path, "bindings"], "action.bindings", "an object of record bindings", raw);
    } else {
      for (const name of presentKeys(raw)) {
        // `__proto__` would silently set the prototype instead of an own
        // key on the plain-object accumulator below; reject it so the
        // binding is never lost. Other dunder names are safe own keys.
        if (name === "__proto__") {
          ok = false;
          pushViolation(
            ctx,
            [...path, "bindings", name],
            "unknown-field",
            `action binding name "__proto__" is reserved`,
            "any other binding name",
            actualWire(raw[name]),
          );
          continue;
        }
        const decoded = decodeActionBinding(ctx, name, raw[name], [...path, "bindings", name]);
        if (decoded === FAIL) {
          ok = false;
        } else {
          bindings[name] = decoded;
        }
      }
    }
  }
  if (!ok || target === FAIL) {
    return FAIL;
  }
  return makeActionRef(target, bindings);
}

function decodeModelRef(ctx: DecodeContext, model: string, wire: Record<string, unknown>, path: Path): DecodeOut {
  let ok = true;
  if (!readKey(wire, "id").present) {
    ok = false;
    pushViolation(
      ctx,
      [...path, "id"],
      "required",
      `ref ${model} is missing "id"`,
      `ref ${model} {id} or {id, version}`,
    );
  }
  const id = decodeIdField(ctx, wire, path, `ref ${model}`, "id");
  if (id === FAIL) {
    ok = false;
  }
  let version: bigint | undefined;
  const versionRaw = readKey(wire, "version");
  if (versionRaw.present) {
    const decoded = decodeInt64(
      ctx,
      versionRaw.value,
      [...path, "version"],
      `ref ${model} version`,
      "canonical int64 string",
    );
    if (decoded === FAIL) {
      ok = false;
    } else {
      version = decoded;
    }
  }
  // `{id, version}` is the mutation shape; anything beyond it is unknown.
  const allowed = new Set(["id", "version"]);
  for (const key of presentKeys(wire)) {
    if (!allowed.has(key)) {
      ok = false;
      pushViolation(
        ctx,
        [...path, key],
        "unknown-field",
        `ref ${model} has no field ${JSON.stringify(key)}`,
        `ref ${model} {id} or {id, version}`,
        actualWire(wire[key]),
      );
    }
  }
  if (!ok || id === FAIL) {
    return FAIL;
  }
  return version === undefined ? makeRecordRef(model, id) : makeRecordRef(model, id, version);
}

/**
 * Untyped structural decode for nominal contract objects: JSON-native
 * leaves pass through; numbers are rejected (exact scalars need schema
 * field types). Every container is frozen.
 */
function decodeDynamic(ctx: DecodeContext, wire: unknown, path: Path): DecodeOut {
  if (wire === null || typeof wire === "string" || typeof wire === "boolean") {
    return wire;
  }
  if (Array.isArray(wire)) {
    const out: CanValue[] = [];
    let ok = true;
    for (let index = 0; index < wire.length; index += 1) {
      const decoded = decodeDynamic(ctx, wire[index], [...path, index]);
      if (decoded === FAIL) {
        ok = false;
      } else {
        out.push(decoded);
      }
    }
    return ok ? freezeArray(out) : FAIL;
  }
  if (isWireObject(wire)) {
    const out: Record<string, CanValue> = {};
    let ok = true;
    for (const key of presentKeys(wire)) {
      // `__proto__` would silently set the prototype instead of an own
      // key on the accumulator below; reject it so the field is never
      // lost. Other dunder names are safe own keys.
      if (key === "__proto__") {
        ok = false;
        pushViolation(
          ctx,
          [...path, key],
          "unknown-field",
          `contract field name "__proto__" is reserved`,
          "any other field name",
          actualWire(wire[key]),
        );
        continue;
      }
      const decoded = decodeDynamic(ctx, wire[key], [...path, key]);
      if (decoded === FAIL) {
        ok = false;
      } else {
        out[key] = decoded;
      }
    }
    return ok ? Object.freeze(out) : FAIL;
  }
  return failType(ctx, path, "contract field", "text, boolean, null, array, or object (numbers never appear)", wire);
}

function decodeNominal(ctx: DecodeContext, model: string, wire: unknown, path: Path): DecodeOut {
  if (typeof wire === "string") {
    return wire;
  }
  if (isWireObject(wire)) {
    if (readKey(wire, "id").present) {
      return decodeModelRef(ctx, model, wire, path);
    }
    return decodeDynamic(ctx, wire, path);
  }
  return failType(
    ctx,
    path,
    `nominal ${model}`,
    `ref ${model} ({id} or {id, version}), a contract object, or an enum spelling`,
    wire,
  );
}

function decodeUnion(
  ctx: DecodeContext,
  arms: readonly string[],
  wire: unknown,
  path: Path,
): DecodeOut {
  if (!isWireObject(wire)) {
    return failType(ctx, path, "union", "{type, value}", wire);
  }
  let ok = checkShape(ctx, wire, path, "union {type, value}", ["type", "value"]);
  let arm: string | typeof FAIL = FAIL;
  const typeRaw = readKey(wire, "type");
  if (typeRaw.present) {
    if (typeof typeRaw.value !== "string") {
      ok = false;
      failType(ctx, [...path, "type"], "union.type", "a declared arm name", typeRaw.value);
    } else if (!arms.includes(typeRaw.value)) {
      ok = false;
      pushViolation(
        ctx,
        [...path, "type"],
        "type",
        "union discriminator names no declared arm",
        `one of: ${arms.join(", ")}`,
        actualWire(typeRaw.value),
      );
    } else {
      arm = typeRaw.value;
    }
  }
  let inner: DecodeOut = FAIL;
  const valueRaw = readKey(wire, "value");
  if (valueRaw.present && arm !== FAIL) {
    const decoded = decodeNode(parseTypeId(arm), valueRaw.value, [...path, "value"], ctx);
    if (decoded === FAIL) {
      ok = false;
    } else {
      inner = decoded;
    }
  }
  if (!ok || arm === FAIL || inner === FAIL) {
    return FAIL;
  }
  return makeUnionValue(arm, inner);
}

function decodeScalar(
  ctx: DecodeContext,
  name: "int" | "decimal" | "money" | "date" | "datetime" | "duration" | "text" | "bool",
  wire: unknown,
  path: Path,
): DecodeOut {
  switch (name) {
    case "int":
      return decodeInt64(ctx, wire, path, "int", "canonical int64 decimal string");
    case "decimal":
      return decodeDecimal(ctx, wire, path);
    case "money":
      return decodeMoney(ctx, wire, path);
    case "date":
      return decodeDate(ctx, wire, path);
    case "datetime":
      return decodeDatetime(ctx, wire, path);
    case "duration":
      return decodeInt64(ctx, wire, path, "duration", "canonical integer-millisecond string");
    case "text":
      if (typeof wire !== "string") {
        return failType(ctx, path, "text", "text", wire);
      }
      return wire;
    case "bool":
      if (typeof wire !== "boolean") {
        return failType(ctx, path, "bool", "boolean", wire);
      }
      return wire;
  }
}

function decodeBase(ctx: DecodeContext, base: TypeBase, wire: unknown, path: Path): DecodeOut {
  switch (base.kind) {
    case "scalar":
      return decodeScalar(ctx, base.name, wire, path);
    case "stringlike":
      return decodeStringlike(ctx, base.name, wire, path);
    case "user":
      return decodeUser(ctx, wire, path);
    case "member":
      return decodeMember(ctx, wire, path);
    case "file":
      return decodeFile(ctx, wire, path);
    case "secret":
      pushViolation(
        ctx,
        path,
        "type",
        "secret values have no wire form",
        "no wire form (secrets are never serialized)",
        actualWire(wire),
      );
      return FAIL;
    case "action":
      return decodeAction(ctx, base.targets, wire, path);
    case "delivery":
      return decodeDelivery(ctx, base.operation, wire, path);
    case "enum":
      if (typeof wire !== "string") {
        return failType(ctx, path, "enum", "a case name", wire);
      }
      if (!base.cases.includes(wire)) {
        return failFormat(ctx, path, "enum", `one of: ${[...base.cases].join(", ")}`, wire);
      }
      return wire;
    case "nominal":
      return decodeNominal(ctx, base.path, wire, path);
    case "union":
      return decodeUnion(ctx, base.arms, wire, path);
  }
}

function decodeNode(ast: NormalizedType, wire: unknown, path: Path, ctx: DecodeContext): DecodeOut {
  if (wire === null) {
    if (ast.nullable) {
      return null;
    }
    return failType(ctx, path, printTypeId(ast), `non-null ${printTypeId(ast)}`, wire);
  }
  if (wire === undefined) {
    return failType(ctx, path, printTypeId(ast), printTypeId(ast), wire);
  }
  if (ast.array) {
    if (!Array.isArray(wire)) {
      return failType(ctx, path, printTypeId(ast), `an array of ${printTypeId(ast)} elements`, wire);
    }
    const element: NormalizedType = { base: ast.base, array: false, nullable: false, requiredArray: false };
    const out: CanValue[] = [];
    let ok = true;
    for (let index = 0; index < wire.length; index += 1) {
      const decoded = decodeNode(element, wire[index], [...path, index], ctx);
      if (decoded === FAIL) {
        ok = false;
      } else {
        out.push(decoded);
      }
    }
    return ok ? freezeArray(out) : FAIL;
  }
  return decodeBase(ctx, ast.base, wire, path);
}

/**
 * Decodes wire data to a frozen `CanValue` per the type id. Malformed wire
 * throws SchemaError with precise paths; a bad type id throws ValueError.
 */
export function decodeValue(typeId: string, wire: unknown): CanValue {
  const ast = parseTypeId(typeId);
  const ctx: DecodeContext = { violations: [] };
  const out = decodeNode(ast, wire, [], ctx);
  if (out === FAIL || ctx.violations.length > 0) {
    throw new SchemaError(ctx.violations);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encode: CanValue -> WireValue (mismatches are caller errors: ValueError).
// ---------------------------------------------------------------------------

function encodeInt64(value: unknown, what: string, path: Path): string {
  if (typeof value !== "bigint") {
    throw encodeError(`${what} must be a bigint`, path);
  }
  if (value < INT64_MIN || value > INT64_MAX) {
    throw encodeError(`${what} out of 64-bit range: ${value.toString()}`, path);
  }
  return value.toString();
}

function encodeDate(value: unknown, path: Path): string {
  if (!isDateValue(value)) {
    throw encodeError("expected a date value", path);
  }
  const year = String(value.year).padStart(4, "0");
  const month = String(value.month).padStart(2, "0");
  const day = String(value.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function encodeDatetime(value: unknown, path: Path): string {
  if (!isDatetime(value)) {
    throw encodeError("expected a datetime value", path);
  }
  try {
    assertDatetimeInRange(value.ms);
  } catch (err) {
    if (!(err instanceof ValueError)) {
      throw err;
    }
    throw encodeError("datetime outside the supported 0001-9999 range", path);
  }
  let days = value.ms / MS_PER_DAY;
  let rem = value.ms % MS_PER_DAY;
  if (rem < 0n) {
    days -= 1n;
    rem += MS_PER_DAY;
  }
  const date = epochDaysToDate(Number(days));
  const dayMs = Number(rem);
  const hour = Math.floor(dayMs / 3600000);
  const minute = Math.floor((dayMs % 3600000) / 60000);
  const second = Math.floor((dayMs % 60000) / 1000);
  const milli = dayMs % 1000;
  return (
    `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}` +
    `T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.` +
    `${String(milli).padStart(3, "0")}Z`
  );
}

function encodeMoneyValue(value: unknown, path: Path): WireValue {
  if (!isMoney(value)) {
    throw encodeError("expected a money value", path);
  }
  if (!isKnownCurrency(value.currency)) {
    throw encodeError(`unknown currency ${JSON.stringify(value.currency)}`, [...path, "currency"]);
  }
  const minor = encodeInt64(value.minor, "money.minor", [...path, "minor"]);
  return Object.freeze({ minor, currency: value.currency });
}

function encodeUserValue(value: unknown, path: Path): WireValue {
  if (!isUserRef(value)) {
    throw encodeError("expected a user ref", path);
  }
  return Object.freeze({ id: value.id });
}

function encodeMemberValue(value: unknown, path: Path): WireValue {
  if (!isMemberRef(value)) {
    throw encodeError("expected a member ref", path);
  }
  return Object.freeze({ id: value.id, user: Object.freeze({ id: value.user.id }), team: value.team });
}

function encodeFileValue(value: unknown, path: Path): WireValue {
  if (!isFileValue(value)) {
    throw encodeError("expected a file value", path);
  }
  return Object.freeze({ id: value.id });
}

function encodeRefValue(value: RecordRef, path: Path): WireValue {
  const version = value.version;
  if (version === undefined) {
    return Object.freeze({ id: value.id });
  }
  if (typeof version !== "bigint") {
    throw encodeError("record version must be a bigint", [...path, "version"]);
  }
  return Object.freeze({ id: value.id, version: encodeInt64(version, "record version", [...path, "version"]) });
}

function encodeDeliveryValue(value: unknown, operation: string | null, path: Path): WireValue {
  if (!isDeliveryRef(value)) {
    throw encodeError("expected a delivery ref", path);
  }
  if (operation !== null && value.operation !== operation) {
    throw encodeError(`delivery is bound to ${JSON.stringify(value.operation)}, not ${JSON.stringify(operation)}`, [
      ...path,
      "operation",
    ]);
  }
  return Object.freeze({ id: value.id, operation: value.operation });
}

function encodeActionValue(value: unknown, targets: readonly string[] | null, path: Path): WireValue {
  if (!isActionRef(value)) {
    throw encodeError("expected an action ref", path);
  }
  if (targets !== null && !targets.includes(value.target)) {
    throw encodeError(`action target ${JSON.stringify(value.target)} is outside this type's allowlist`, [
      ...path,
      "target",
    ]);
  }
  const bindings: Record<string, WireValue> = {};
  for (const [name, binding] of Object.entries(value.bindings)) {
    // `__proto__` would silently set the prototype instead of an own key
    // on the accumulator below; reject it like the decoder so the
    // binding is never lost. Other dunder names are safe own keys.
    if (name === "__proto__") {
      throw encodeError('action binding name "__proto__" is reserved', [...path, "bindings", name]);
    }
    if (!isRecordRef(binding)) {
      throw encodeError(`action binding ${JSON.stringify(name)} must be a record ref`, [...path, "bindings", name]);
    }
    if (typeof binding.version !== "bigint") {
      throw encodeError(
        `action binding ${JSON.stringify(name)} requires an expected version`,
        [...path, "bindings", name, "version"],
      );
    }
    bindings[name] = Object.freeze({
      id: binding.id,
      version: encodeInt64(binding.version, "action binding version", [...path, "bindings", name, "version"]),
    });
  }
  return Object.freeze({ target: value.target, bindings: Object.freeze(bindings) });
}

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
  "delivery",
  "file",
  "secret",
]);

function kindTagOf(value: object): string | null {
  const kind = (value as Record<string, unknown>)["kind"];
  return typeof kind === "string" ? kind : null;
}

function isSecretValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && kindTagOf(value) === "secret";
}

/**
 * True for objects carrying a known value tag: a failed shape guard means a
 * malformed value (never a contract). Unknown tags encode as plain
 * contracts, mirroring equality.ts.
 */
function hasKnownKindTag(value: object): boolean {
  const tag = kindTagOf(value);
  return tag !== null && KNOWN_VALUE_KINDS.has(tag);
}

/**
 * Runtime-kind-driven encode for nominal contract values: bigints become
 * canonical strings, tagged values use their pinned shapes, secrets and
 * message descriptors throw (neither has a wire form).
 */
function encodeDynamic(value: CanValue, path: Path): WireValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return encodeInt64(value, "int", path);
  }
  if (isDecimal(value)) {
    return decimalToString(value);
  }
  if (isMoney(value)) {
    return encodeMoneyValue(value, path);
  }
  if (isDateValue(value)) {
    return encodeDate(value, path);
  }
  if (isDatetime(value)) {
    return encodeDatetime(value, path);
  }
  if (isUserRef(value)) {
    return encodeUserValue(value, path);
  }
  if (isMemberRef(value)) {
    return encodeMemberValue(value, path);
  }
  if (isRecordRef(value)) {
    return encodeRefValue(value, path);
  }
  if (isActionRef(value)) {
    return encodeActionValue(value, null, path);
  }
  if (isDeliveryRef(value)) {
    return encodeDeliveryValue(value, null, path);
  }
  if (isFileValue(value)) {
    return encodeFileValue(value, path);
  }
  if (isUnionValue(value)) {
    return Object.freeze({ type: value.type, value: encodeDynamic(value.value, [...path, "value"]) });
  }
  if (isSecretValue(value)) {
    throw encodeError("secret values are never serialized", path);
  }
  // MessageDescriptor is not a CanValue: encoding one as a plain contract
  // would silently lose type fidelity (exact-scalar params decode back as
  // strings), so message descriptors have no wire form.
  if (typeof value === "object" && value !== null && !Array.isArray(value) && kindTagOf(value) === "message") {
    throw encodeError("message descriptors have no wire form", path);
  }
  if (Array.isArray(value)) {
    const out: WireValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      out.push(encodeDynamic(value[index] as CanValue, [...path, index]));
    }
    return freezeArray(out);
  }
  if (typeof value === "object" && value !== null) {
    if (hasKnownKindTag(value)) {
      throw encodeError(`malformed tagged value (kind ${JSON.stringify(kindTagOf(value))})`, path);
    }
    const out: Record<string, WireValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      // `__proto__` would silently set the prototype instead of an own
      // key on the accumulator below; reject it like the decoder so the
      // field is never lost. Other dunder names are safe own keys.
      if (key === "__proto__") {
        throw encodeError('contract field name "__proto__" is reserved', [...path, key]);
      }
      out[key] = encodeDynamic(entry as CanValue, [...path, key]);
    }
    return Object.freeze(out);
  }
  throw encodeError(`cannot encode ${actualWire(value)}`, path);
}

function encodeScalar(name: ScalarName, value: CanValue, path: Path): WireValue {
  switch (name) {
    case "int":
      return encodeInt64(value, "int", path);
    case "decimal":
      if (!isDecimal(value)) {
        throw encodeError("expected a decimal value", path);
      }
      return decimalToString(value);
    case "money":
      return encodeMoneyValue(value, path);
    case "date":
      return encodeDate(value, path);
    case "datetime":
      return encodeDatetime(value, path);
    case "duration":
      return encodeInt64(value, "duration", path);
    case "text":
      if (typeof value !== "string") {
        throw encodeError("expected text", path);
      }
      return value;
    case "bool":
      if (typeof value !== "boolean") {
        throw encodeError("expected a boolean", path);
      }
      return value;
  }
}

function encodeStringlike(name: StringLikeName, value: CanValue, path: Path): WireValue {
  if (typeof value !== "string") {
    throw encodeError(`expected ${name} text`, path);
  }
  switch (name) {
    case "email":
    case "url":
      return value;
    case "locale":
      try {
        return canonicalLocale(value);
      } catch (err) {
        if (!(err instanceof ValueError)) {
          throw err;
        }
        throw encodeError(`invalid BCP 47 tag ${JSON.stringify(value)}`, path);
      }
    case "timezone":
      if (!isTimezone(value)) {
        throw encodeError(`unknown IANA zone ${JSON.stringify(value)}`, path);
      }
      return value;
    case "currency":
      if (!isKnownCurrency(value)) {
        throw encodeError(`unknown currency ${JSON.stringify(value)}`, path);
      }
      return value;
  }
}

function encodeNominal(model: string, value: CanValue, path: Path): WireValue {
  if (typeof value === "string") {
    return value;
  }
  if (isRecordRef(value)) {
    if (value.model !== model) {
      throw encodeError(`expected a ref to ${model}, got a ref to ${value.model}`, path);
    }
    return encodeRefValue(value, path);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (hasKnownKindTag(value)) {
      throw encodeError(`expected a ${model} value`, path);
    }
    return encodeDynamic(value, path);
  }
  throw encodeError(`expected a ${model} value`, path);
}

function encodeUnion(arms: readonly string[], value: CanValue, path: Path): WireValue {
  if (!isUnionValue(value)) {
    throw encodeError("expected a union value", path);
  }
  if (!arms.includes(value.type)) {
    throw encodeError(`union branch ${JSON.stringify(value.type)} is not a declared arm`, [...path, "type"]);
  }
  const inner = encodeNode(parseTypeId(value.type), value.value, [...path, "value"]);
  return Object.freeze({ type: value.type, value: inner });
}

function encodeBase(base: TypeBase, value: CanValue, path: Path): WireValue {
  switch (base.kind) {
    case "scalar":
      return encodeScalar(base.name, value, path);
    case "stringlike":
      return encodeStringlike(base.name, value, path);
    case "user":
      return encodeUserValue(value, path);
    case "member":
      return encodeMemberValue(value, path);
    case "file":
      return encodeFileValue(value, path);
    case "secret":
      throw encodeError("secret values are never serialized", path);
    case "action": {
      const action = value as ActionRef;
      return encodeActionValue(action, base.targets, path);
    }
    case "delivery": {
      const delivery = value as DeliveryRef;
      return encodeDeliveryValue(delivery, base.operation, path);
    }
    case "enum":
      if (typeof value !== "string") {
        throw encodeError("expected an enum case name", path);
      }
      if (!base.cases.includes(value)) {
        throw encodeError(`unknown enum case ${JSON.stringify(value)}`, path);
      }
      return value;
    case "nominal":
      return encodeNominal(base.path, value, path);
    case "union": {
      const union = value as UnionValue;
      return encodeUnion(base.arms, union, path);
    }
  }
}

function encodeNode(ast: NormalizedType, value: CanValue, path: Path): WireValue {
  if (value === null) {
    if (ast.nullable) {
      return null;
    }
    throw encodeError(`null for non-nullable ${printTypeId(ast)}`, path);
  }
  if (value === undefined) {
    throw encodeError("undefined is not a Can value", path);
  }
  if (ast.array) {
    if (!Array.isArray(value)) {
      throw encodeError(`expected an array of ${printTypeId(ast)}`, path);
    }
    const element: NormalizedType = { base: ast.base, array: false, nullable: false, requiredArray: false };
    const out: WireValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      out.push(encodeNode(element, value[index] as CanValue, [...path, index]));
    }
    return freezeArray(out);
  }
  return encodeBase(ast.base, value, path);
}

/**
 * Encodes a `CanValue` to frozen wire data per the type id. Value/type
 * mismatches (and every secret encode) throw ValueError; a bad type id
 * throws ValueError too.
 */
export function encodeValue(typeId: string, value: CanValue): WireValue {
  const ast = parseTypeId(typeId);
  return encodeNode(ast, value, []);
}
