/** Public schema facade. Arbitrary callers always enter the canonical TS core. */
import type { CanValue, ContractValue } from "@canlang/contracts/values";
import type { CanonicalValueTypes } from "@canlang/contracts";
import { normalizeSchema, validateValueTsCore, validateOperationInputTsCore } from "./internal/schema-core.js";
import type { NormalizedSchema, UpdateContract, ValidationMode } from "./internal/schema-core.js";
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

/** Fold declarations once without losing duplicate names; codecs own the resulting schema. */
export function normalizeValueTypes(inventory: unknown): {
  readonly valueTypes: CanonicalValueTypes;
  readonly valueSchema: NormalizedSchema;
} {
  const fail = (code: ValueTypesError["code"], message: string): never => { throw new ValueTypesError(code, message); };
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const keys = (value: object, expected: readonly string[]): boolean =>
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
  if (!record(inventory) || !keys(inventory, Object.hasOwn(inventory, "enums") ? ["contracts", "enums"] : ["contracts"]) ||
      !Array.isArray(inventory["contracts"]) || Object.hasOwn(inventory, "enums") && !Array.isArray(inventory["enums"])) {
    return fail("malformed", "valueTypes requires contracts and optional enums declaration arrays.");
  }
  const contractEntries = inventory["contracts"];
  const enumEntries = inventory["enums"] as unknown[] | undefined ?? [];
  const contracts: Record<string, { fields: Record<string, { type: string }> }> = Object.create(null);
  const enums: Record<string, { cases: readonly string[] }> = Object.create(null);
  const names = new Set<string>();
  for (const declaration of [...contractEntries, ...enumEntries]) {
    if (!record(declaration) || typeof declaration["name"] !== "string" || !Object.hasOwn(declaration, "name")) {
      return fail("malformed", "valueTypes requires own declaration names.");
    }
    const name = declaration["name"];
    try {
      const type = parseTypeId(name);
      if (type.base.kind !== "nominal" || type.array || type.nullable || printTypeId(type) !== name) throw new Error();
    } catch { return fail("malformed", "valueTypes requires canonical bare nominal names."); }
    if (names.has(name)) return fail("duplicate", `Duplicate valueTypes declaration ${JSON.stringify(name)}.`);
    names.add(name);
  }
  const copiedContracts: CanonicalValueTypes["contracts"][number][] = [];
  for (const declaration of contractEntries) {
    if (!record(declaration) || !keys(declaration, ["name", "fields"]) || !Array.isArray(declaration["fields"])) {
      return fail("malformed", "valueTypes contract requires an own fields array.");
    }
    const name = declaration["name"] as string;
    const fields: Record<string, { type: string }> = Object.create(null);
    const copied: { readonly name: string; readonly type: string }[] = [];
    for (const field of declaration["fields"]) {
      if (!record(field) || !keys(field, ["name", "type"]) || typeof field["name"] !== "string" ||
          field["name"] === "" || typeof field["type"] !== "string") return fail("malformed", "Invalid valueTypes field.");
      if (Object.hasOwn(fields, field["name"])) return fail("duplicate", `Duplicate valueTypes field ${JSON.stringify(field["name"])}.`);
      let parsed;
      try {
        parsed = parseTypeId(field["type"]);
        if (printTypeId(parsed) !== field["type"]) throw new Error();
      } catch { return fail("malformed", `Noncanonical valueTypes field ${JSON.stringify(field["name"])}.`); }
      if (parsed.base.kind === "nominal" && !names.has(parsed.base.path)) {
        return fail("dangling", `Undeclared valueTypes nominal ${JSON.stringify(parsed.base.path)}.`);
      }
      fields[field["name"]] = { type: field["type"] };
      copied.push(Object.freeze({ name: field["name"], type: field["type"] }));
    }
    contracts[name] = { fields };
    copiedContracts.push(Object.freeze({ name, fields: Object.freeze(copied) }));
  }
  const copiedEnums: NonNullable<CanonicalValueTypes["enums"]>[number][] = [];
  for (const declaration of enumEntries) {
    if (!record(declaration) || !keys(declaration, ["name", "cases"]) || !Array.isArray(declaration["cases"]) ||
        declaration["cases"].some((entry: unknown) => typeof entry !== "string")) return fail("malformed", "Invalid valueTypes enum.");
    const name = declaration["name"] as string;
    const cases = Object.freeze([...declaration["cases"]] as string[]);
    enums[name] = { cases };
    copiedEnums.push(Object.freeze({ name, cases }));
  }
  let valueSchema: NormalizedSchema;
  try { valueSchema = normalizeSchema({ contracts, enums }); }
  catch (error) { return fail("malformed", `Invalid valueTypes inventory: ${String(error)}`); }
  const valueTypes = Object.freeze({ contracts: Object.freeze(copiedContracts),
    ...(Object.hasOwn(inventory, "enums") ? { enums: Object.freeze(copiedEnums) } : {}) });
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
