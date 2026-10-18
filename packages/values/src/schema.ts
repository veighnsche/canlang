/** Public schema facade. Arbitrary callers always enter the canonical TS core. */
import type { CanValue, ContractValue, WireValue } from "@canlang/contracts/values";
import type { CanonicalNominalLeaf, CanonicalValueTypes } from "@canlang/contracts";
import { normalizeSchema, validateValueTsCore, validateOperationInputTsCore } from "./internal/schema-core.js";
import type { FieldDescriptor, NormalizedSchema, UpdateContract, ValidationMode } from "./internal/schema-core.js";
import { parseTypeId, printTypeId } from "./types.js";

export type {
  ValidationMode, UpdateContract, FieldDescriptor, ContractDescriptor, EnumDescriptor,
  OperationDescriptor, SchemaDescriptor, NormalizedField, NormalizedContract,
  NormalizedEnum, NormalizedOperation, NormalizedSchema,
} from "./internal/schema-core.js";

/** Admission errors for the compiler's finite nominal inventory. */
export class ValueTypesError extends Error {
  constructor(readonly code: "malformed" | "duplicate" | "dangling", message: string) {
    super(message);
    this.name = "ValueTypesError";
  }
}

/**
 * Fold declarations once without losing duplicate names; codecs own the resulting schema.
 * Model names come from the loader's same-load model declarations, never value contracts.
 * They permit reference shape validation only; the loader retains identity and authority checks.
 */
type ValueTypesFail = (code: ValueTypesError["code"], message: string) => never;

function isInventoryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact own-key match for inventory descriptors. */
function inventoryKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

/** Inventory shape gate: contracts plus optional enums/aliases arrays. */
function checkInventoryShape(inventory: unknown, fail: ValueTypesFail): asserts inventory is Record<string, unknown> {
  if (!isInventoryRecord(inventory) || !inventoryKeys(inventory, ["contracts", ...(Object.hasOwn(inventory, "enums") ? ["enums"] : []), ...(Object.hasOwn(inventory, "aliases") ? ["aliases"] : [])]) ||
      !Array.isArray(inventory["contracts"]) || Object.hasOwn(inventory, "enums") && !Array.isArray(inventory["enums"]) ||
      Object.hasOwn(inventory, "aliases") && !Array.isArray(inventory["aliases"])) {
    return fail("malformed", "valueTypes requires contracts and optional enums declaration arrays.");
  }
}

/** Collect model and declaration names, refusing duplicates. */
function collectDeclarationNames(
  modelNames: readonly string[],
  contractEntries: readonly unknown[],
  enumEntries: readonly unknown[],
  aliasEntries: readonly unknown[],
  canonicalNominal: (name: unknown) => boolean,
  fail: ValueTypesFail,
): { names: Set<string>; models: Set<string> } {
  const names = new Set<string>();
  const models = new Set<string>();
  if (!Array.isArray(modelNames)) return fail("malformed", "valueTypes model context requires a model-name array.");
  for (const name of modelNames) {
    if (!canonicalNominal(name)) return fail("malformed", "valueTypes model context requires canonical bare nominal names.");
    if (models.has(name)) return fail("duplicate", `Duplicate valueTypes model ${JSON.stringify(name)}.`);
    models.add(name);
  }
  for (const declaration of [...contractEntries, ...enumEntries, ...aliasEntries]) {
    if (!isInventoryRecord(declaration) || typeof declaration["name"] !== "string" || !Object.hasOwn(declaration, "name")) {
      return fail("malformed", "valueTypes requires own declaration names.");
    }
    const name = declaration["name"];
    if (!canonicalNominal(name)) return fail("malformed", "valueTypes requires canonical bare nominal names.");
    if (names.has(name) || models.has(name)) return fail("duplicate", `Duplicate valueTypes declaration ${JSON.stringify(name)}.`);
    names.add(name);
  }
  return { names, models };
}

/** Constraint-shape check plus frozen constraint copy for one field. */
function readFieldConstraints(
  field: Record<string, unknown>,
  copyBound: (value: unknown) => WireValue,
  fail: ValueTypesFail,
): Record<string, unknown> {
  if (["min", "max"].some(key => Object.hasOwn(field, key) && field[key] === undefined) ||
      Object.hasOwn(field, "trim") && typeof field["trim"] !== "boolean" ||
      Object.hasOwn(field, "format") && field["format"] !== "name" ||
      Object.hasOwn(field, "distinctBy") && field["distinctBy"] !== "id" ||
      Object.hasOwn(field, "excludedIds") && (!Array.isArray(field["excludedIds"]) || field["excludedIds"].some((entry: unknown) => typeof entry !== "string"))) {
    return fail("malformed", "Invalid valueTypes field constraints.");
  }
  return {
    ...(Object.hasOwn(field, "trim") ? { trim: field["trim"] as boolean } : {}),
    ...(Object.hasOwn(field, "min") ? { min: copyBound(field["min"]) } : {}),
    ...(Object.hasOwn(field, "max") ? { max: copyBound(field["max"]) } : {}),
    ...(Object.hasOwn(field, "format") ? { format: "name" as const } : {}),
    ...(Object.hasOwn(field, "distinctBy") ? { distinctBy: "id" as const } : {}),
    ...(Object.hasOwn(field, "excludedIds") ? { excludedIds: Object.freeze(Array.from(field["excludedIds"] as string[])) } : {}),
  };
}

/** Exact int bound strings for legacy numeric metadata; never via Number. */
function readIntValueBounds(
  parsed: ReturnType<typeof parseTypeId>,
  field: Record<string, unknown>,
  fail: ValueTypesFail,
): { min?: string; max?: string } {
  // Preserve exact scalar wire bounds. Legacy numeric int metadata can
  // convert only while exact; never route full-int64 bounds through Number.
  const valueBounds: { min?: string; max?: string } = {};
  if (!parsed.array && parsed.base.kind === "scalar" && parsed.base.name === "int") {
    for (const key of ["min", "max"] as const) if (Object.hasOwn(field, key) && typeof field[key] === "number") {
      if (!Number.isSafeInteger(field[key])) return fail("malformed", "valueTypes int bounds require exact safe integers.");
      valueBounds[key] = String(field[key]);
    }
  }
  return valueBounds;
}

/** Validate one field declaration into its descriptor plus frozen copy. */
function readValueTypesField(
  field: unknown,
  seen: ReadonlySet<string>,
  declarations: ReadonlySet<string>,
  models: ReadonlySet<string>,
  copyBound: (value: unknown) => WireValue,
  fail: ValueTypesFail,
): { name: string; descriptor: FieldDescriptor; copied: CanonicalNominalLeaf } {
  if (!isInventoryRecord(field) || !inventoryKeys(field, ["name", "type", ...["trim", "min", "max", "format", "distinctBy", "excludedIds"].filter(key => Object.hasOwn(field, key))]) || typeof field["name"] !== "string" ||
      field["name"] === "" || typeof field["type"] !== "string") return fail("malformed", "Invalid valueTypes field.");
  if (seen.has(field["name"])) return fail("duplicate", `Duplicate valueTypes field ${JSON.stringify(field["name"])}.`);
  let parsed;
  try {
    parsed = parseTypeId(field["type"]);
    if (printTypeId(parsed) !== field["type"]) throw new Error();
  } catch { return fail("malformed", `Noncanonical valueTypes field ${JSON.stringify(field["name"])}.`); }
  if (parsed.base.kind === "nominal" && !declarations.has(parsed.base.path) && !models.has(parsed.base.path)) {
    return fail("dangling", `Undeclared valueTypes nominal ${JSON.stringify(parsed.base.path)}.`);
  }
  const constraints = readFieldConstraints(field, copyBound, fail);
  const valueBounds = readIntValueBounds(parsed, field, fail);
  const name = field["name"] as string;
  return {
    name,
    descriptor: { type: field["type"], ...constraints, ...valueBounds } as FieldDescriptor,
    copied: Object.freeze({ name, type: field["type"], ...constraints }),
  };
}

/** Validate one contract declaration into descriptors plus frozen copy. */
function readValueTypesContract(
  declaration: unknown,
  declarations: ReadonlySet<string>,
  models: ReadonlySet<string>,
  copyBound: (value: unknown) => WireValue,
  fail: ValueTypesFail,
): { name: string; fields: Record<string, FieldDescriptor>; copied: CanonicalValueTypes["contracts"][number] } {
  if (!isInventoryRecord(declaration) || !inventoryKeys(declaration, ["name", "fields"]) || !Array.isArray(declaration["fields"])) {
    return fail("malformed", "valueTypes contract requires an own fields array.");
  }
  const name = declaration["name"] as string;
  const fields: Record<string, FieldDescriptor> = Object.create(null);
  const copied: CanonicalNominalLeaf[] = [];
  const seen = new Set<string>();
  for (const field of declaration["fields"]) {
    const read = readValueTypesField(field, seen, declarations, models, copyBound, fail);
    seen.add(read.name);
    fields[read.name] = read.descriptor;
    copied.push(read.copied);
  }
  return { name, fields, copied: Object.freeze({ name, fields: Object.freeze(copied) }) };
}

/** Validate one enum declaration into its frozen cases. */
function readValueTypesEnum(
  declaration: unknown,
  fail: ValueTypesFail,
): { name: string; cases: readonly string[] } {
  if (!isInventoryRecord(declaration) || !inventoryKeys(declaration, ["name", "cases"]) || !Array.isArray(declaration["cases"]) ||
      declaration["cases"].some((entry: unknown) => typeof entry !== "string")) return fail("malformed", "Invalid valueTypes enum.");
  const name = declaration["name"] as string;
  return { name, cases: Object.freeze([...declaration["cases"]] as string[]) };
}

/** Validate one alias declaration into its bounded-text descriptor. */
function readValueTypesAlias(
  declaration: unknown,
  fail: ValueTypesFail,
): { name: string; descriptor: { readonly type: "text"; readonly min: number; readonly max: number; readonly format: "name" } } {
  if (!isInventoryRecord(declaration) || !inventoryKeys(declaration, ["name", "type", "min", "max", "format"]) ||
      declaration["type"] !== "text" || declaration["format"] !== "name" ||
      typeof declaration["min"] !== "number" || typeof declaration["max"] !== "number") {
    return fail("malformed", "valueTypes aliases require bounded text with NAME format.");
  }
  const name = declaration["name"] as string;
  return { name, descriptor: { type: "text" as const, min: declaration["min"] as number, max: declaration["max"] as number, format: "name" as const } };
}

export function normalizeValueTypes(inventory: unknown, modelNames: readonly string[] = []): {
  readonly valueTypes: CanonicalValueTypes;
  readonly valueSchema: NormalizedSchema;
} {
  const fail: ValueTypesFail = (code, message): never => { throw new ValueTypesError(code, message); };
  const record = isInventoryRecord;
  // The core admits only primitive bounds or a closed, flat money wire object.
  // Detach objects before validation; malformed/nested bounds never publish.
  const copyBound = (value: unknown): WireValue =>
    record(value) ? Object.freeze({ ...value }) as WireValue : value as WireValue;
  const canonicalNominal = (name: unknown): name is string => {
    if (typeof name !== "string") return false;
    try {
      const type = parseTypeId(name);
      return type.base.kind === "nominal" && !type.array && !type.nullable && printTypeId(type) === name;
    } catch { return false; }
  };
  checkInventoryShape(inventory, fail);
  const contractEntries = inventory["contracts"] as unknown[];
  const enumEntries = (inventory["enums"] as unknown[] | undefined) ?? [];
  const aliasEntries = (inventory["aliases"] as unknown[] | undefined) ?? [];
  const aliases: Record<string, FieldDescriptor> = Object.create(null);
  const contracts: Record<string, { fields: Record<string, FieldDescriptor> }> = Object.create(null);
  const enums: Record<string, { cases: readonly string[] }> = Object.create(null);
  const { names, models } = collectDeclarationNames(modelNames, contractEntries, enumEntries, aliasEntries, canonicalNominal, fail);
  const copiedContracts: CanonicalValueTypes["contracts"][number][] = [];
  for (const declaration of contractEntries) {
    const read = readValueTypesContract(declaration, names, models, copyBound, fail);
    contracts[read.name] = { fields: read.fields };
    copiedContracts.push(read.copied);
  }
  const copiedEnums: NonNullable<CanonicalValueTypes["enums"]>[number][] = [];
  for (const declaration of enumEntries) {
    const read = readValueTypesEnum(declaration, fail);
    enums[read.name] = { cases: read.cases };
    copiedEnums.push(Object.freeze({ name: read.name, cases: read.cases }));
  }
  const copiedAliases: NonNullable<CanonicalValueTypes["aliases"]>[number][] = [];
  for (const declaration of aliasEntries) {
    const read = readValueTypesAlias(declaration, fail);
    aliases[read.name] = read.descriptor;
    copiedAliases.push(Object.freeze({ name: read.name, ...read.descriptor }));
  }
  let valueSchema: NormalizedSchema;
  try { valueSchema = normalizeSchema({ contracts, enums, ...(Object.hasOwn(inventory, "aliases") ? { aliases } : {}) }); }
  catch (error) { return fail("malformed", `Invalid valueTypes inventory: ${String(error)}`); }
  const valueTypes = Object.freeze({ contracts: Object.freeze(copiedContracts),
    ...(Object.hasOwn(inventory, "enums") ? { enums: Object.freeze(copiedEnums) } : {}),
    ...(Object.hasOwn(inventory, "aliases") ? { aliases: Object.freeze(copiedAliases) } : {}) });
  return Object.freeze({ valueTypes, valueSchema });
}
export {
  UPDATE_OMITTED, isUpdateOmitted, ENGINE_RESOLVED, isEngineResolved, normalizeSchema,
} from "./internal/schema-core.js";

/** Create mode retains canonical defaults and drops engine-resolved omissions. */
export function validateValue(
  schema: NormalizedSchema, typeId: string, wire: unknown, mode: "create",
): CanValue;
/** Update mode retains the canonical UPDATE_OMITTED sentinel. */
export function validateValue(
  schema: NormalizedSchema, typeId: string, wire: unknown, mode: "update",
): CanValue | UpdateContract;
export function validateValue(
  schema: NormalizedSchema, typeId: string, wire: unknown, mode: ValidationMode,
): CanValue | UpdateContract {
  return validateValueTsCore(schema, typeId, wire, mode as "create");
}

/** Validate operation inputs at their original assertion/framing position. */
export function validateOperationInput(
  schema: NormalizedSchema, opName: string, args: unknown,
): ContractValue {
  return validateOperationInputTsCore(schema, opName, args);
}
