/** Ordinary TS serving registration. A trusted loader supplies the checked
 * descriptor and actual source revision; this binding never authenticates a
 * loader, switches a backend or adopts a native handle. Owner/schema/plan
 * identity stays private to the returned lifetime. */
import type { CanValue } from "@canlang/contracts/values";
import type { NormalizedSchema, SchemaDescriptor, UpdateContract, ValidationMode } from "../src/schema.js";
import {
  createPlanOwner, getValidationPlan, registerFactoryValidationPlan,
  releaseValidationPlan, resolvePlanDefault,
  type DefaultRef, type OwnerScope, type PreparedValidationPlan,
} from "../src/prepared/plan.js";
import { validatePreparedValue } from "../src/prepared/validation.js";
import { encodeValue } from "../src/wire.js";
import { isDecimal, decimalToString } from "../src/decimal.js";
import type { WireValue } from "@canlang/contracts/values";

/** Compiler declarations hold ordinary CanValues. Encode with the owning
 * codec, then preserve declared Decimal scale (canonical value wire normally
 * removes trailing zeros). This is metadata for the existing factory, not
 * a different wire format/backend. Nested literal Decimal defaults retain
 * the same coefficient/scale as their genuine source values. */
export function encodeServingLiteral(typeId: string, value: CanValue): WireValue {
  const retain = (native: CanValue, wire: WireValue): WireValue => {
    if (isDecimal(native)) {
      const canonical = decimalToString(native), point = canonical.indexOf('.');
      const digits = point < 0 ? 0 : canonical.length - point - 1;
      return native.scale === digits ? canonical : canonical + (point < 0 ? '.' : '') + '0'.repeat(native.scale - digits);
    }
    if (Array.isArray(native) && Array.isArray(wire)) return wire.map((entry, index) => retain(native[index]!, entry));
    if (native !== null && typeof native === 'object' && wire !== null && typeof wire === 'object' && !Array.isArray(wire)) {
      return Object.fromEntries(Object.entries(wire).map(([key, entry]) => [key,
        Object.hasOwn(native, key) ? retain((native as Record<string, CanValue>)[key]!, entry) : entry]));
    }
    return wire;
  };
  return retain(value, encodeValue(typeId, value));
}

export interface ServingValidation {
  readonly scope: OwnerScope;
  readonly schema: NormalizedSchema;
  plan(): PreparedValidationPlan;
  validate(typeId: string, wire: unknown, mode: ValidationMode): CanValue | UpdateContract;
  resolveDefault(ref: DefaultRef): CanValue;
  close(): void;
}

export function createServingValidation(scope: OwnerScope, descriptor: SchemaDescriptor): ServingValidation {
  const owner = createPlanOwner(scope);
  const { schema, id } = registerFactoryValidationPlan(owner, scope.profileVersion, descriptor);
  return Object.freeze({
    scope: owner.scope,
    schema,
    plan: () => getValidationPlan(owner, id),
    validate: (typeId: string, wire: unknown, mode: ValidationMode) =>
      validatePreparedValue(owner, id, schema, typeId, wire, mode),
    resolveDefault: (ref: DefaultRef) => resolvePlanDefault(owner, ref),
    close: () => releaseValidationPlan(owner, id),
  });
}
