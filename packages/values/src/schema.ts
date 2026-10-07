/** Public schema facade. Arbitrary callers always enter the canonical TS core. */
import type { CanValue, ContractValue } from "@canlang/contracts/values";
import { validateValueTsCore, validateOperationInputTsCore } from "./internal/schema-core.js";
import type { NormalizedSchema, UpdateContract, ValidationMode } from "./internal/schema-core.js";

export type {
  ValidationMode, UpdateContract, FieldDescriptor, ContractDescriptor, EnumDescriptor,
  OperationDescriptor, SchemaDescriptor, NormalizedField, NormalizedContract,
  NormalizedEnum, NormalizedOperation, NormalizedSchema,
} from "./internal/schema-core.js";
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
