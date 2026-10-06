/**
 * P2 MCP runtime: `CompileArtifact` -> `OperationRegistry` adapter (join J3).
 *
 * The production binding the `ports.ts` seams promise: operation
 * descriptors flow from the owning L1 artifact (P1 `operations[]`), not
 * from the interim engine-local table (`state/.../registry.ts`, which is
 * replaced outright at the L1 codegen join) and not from the
 * `createFakeOperationRegistry` test double. The worker assembly loads
 * this module via dynamic `import()` and feeds the builders below into
 * the assembled `McpDeps`.
 *
 * Types mirror `packages/interfaces/src/ports.ts` VERBATIM (each cites
 * its source): `@canlang/interfaces` is not a dependency of this
 * package, so a direct import is impossible, and a relative type import
 * would break the composite `rootDir`. Structural identity is proven by
 * static assertions in `test/mcp-route.test.ts`, which assigns every
 * builder result to the REAL ports.ts type. The deploy join swaps these
 * mirrors for the real import with no semantic change.
 *
 * Worker-safe: type-only `@canlang/contracts` import, no `node:`
 * builtins, no I/O. Pure functions over the artifact JSON.
 */

import type { CompileArtifact, DerivedOperationInputs, ResolvedIdentity } from "@canlang/contracts";

/* ------------------------------------------------------------------ */
/* Verbatim mirrors of `packages/interfaces/src/ports.ts`.             */
/* ------------------------------------------------------------------ */

/** Mirror of `McpSchemaField` (`ports.ts:151`). */
export type McpSchemaField =
  | { readonly kind: "ref"; readonly model: string; readonly requireVersion: boolean }
  | { readonly kind: "string" }
  | { readonly kind: "integer" }
  | { readonly kind: "decimal" }
  | { readonly kind: "money" }
  | { readonly kind: "datetime" }
  | { readonly kind: "boolean" }
  | { readonly kind: "file" }
  | { readonly kind: "enum"; readonly values: readonly string[] };

/** Mirror of `McpNamedField` (`ports.ts:162`). */
export interface McpNamedField {
  readonly name: string;
  readonly field: McpSchemaField;
  readonly required: boolean;
  /** Authored `@{desc="..."}` text, verbatim; absent when not authored (MCP P4). */
  readonly description?: string;
}

/** Mirror of `McpInputSchema` (`ports.ts:169`). */
export interface McpInputSchema {
  readonly fields: readonly McpNamedField[];
}

/** Mirror of `McpOperationKind` (`ports.ts:173`). */
export type McpOperationKind =
  | "read"
  | "list"
  | "create"
  | "update"
  | "delete"
  | "scenario"
  | "team";

/** Mirror of `OperationDescriptor` (`ports.ts:187`). */
export interface OperationDescriptor {
  readonly name: string;
  readonly kind: McpOperationKind;
  readonly description: string;
  readonly inputs: McpInputSchema;
}

/**
 * Mirror of `OperationRegistry` (`ports.ts:197`) with one honest
 * widening: the `app` parameter is `unknown` instead of `AppInfo`. This
 * adapter serves a single-app artifact and never reads the argument, and
 * the real `AppInfo.brand` is a `MessageValue` this package cannot name
 * (no interfaces dependency). `unknown` keeps the assignability proof
 * (`test/mcp-route.test.ts`) exact in the direction that matters: this
 * registry IS a real `OperationRegistry`.
 */
export interface OperationRegistry {
  list(app: unknown): readonly OperationDescriptor[];
}

/** Mirror of `OperationInputShape` (`ports.ts:25`). */
export interface OperationInputShape {
  readonly allowed: readonly string[];
  readonly required: readonly string[];
}

/**
 * Mirror of `SchemaCatalog` (`ports.ts:32`), including the E1
 * binding-visibility channel (`derivedFor?`): dispatch invokes the
 * pure bound checker (`checkBoundArguments`) against these inputs
 * after the framing checks; an absent channel keeps framing-only
 * behavior (legacy/test doubles).
 */
export interface SchemaCatalog {
  shapeFor(operation: string): OperationInputShape | null;
  derivedFor?(operation: string): DerivedOperationInputs | null;
}

/** Mirror of `McpPermissions` (`ports.ts:205`). */
export interface McpPermissions {
  canDiscover(identity: ResolvedIdentity, operation: string): boolean | Promise<boolean>;
  canCall(identity: ResolvedIdentity, operation: string): boolean | Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* P1 artifact input shape (`/tmp/mcp-scope.md` §c-P1, confirmed       */
/* against the sibling's `compiler/tests/mcp_p1.rs` golden +           */
/* `test/artifact-operations.test.ts` compat contract).                */
/*                                                                     */
/* `CompileArtifact.operations[]` entries carry exactly                 */
/* {name, kind, description, inputs} with `inputs = {fields:           */
/* [{name, field, required}]}` — the ports.ts `McpInputSchema` /       */
/* `McpNamedField` vocabulary verbatim, no second shape. `kind` is a   */
/* `McpOperationKind`; `description` is the verbatim `#` text (`""`    */
/* when the operation carries none). `CompileArtifact` does not carry  */
/* the field yet, so the builders read it defensively (absent -> empty */
/* registry, never a throw); the day P1 lands, only the defensive read */
/* narrows to the real field.                                          */
/* ------------------------------------------------------------------ */

/** One P1-emitted operation entry (see header). */
export interface ArtifactOperation {
  readonly name: string;
  readonly kind: string;
  readonly description: string;
  readonly inputs: ArtifactOperationInputs;
}

/** P1-emitted typed inputs object (ports.ts `McpInputSchema` shape). */
export interface ArtifactOperationInputs {
  readonly fields: readonly ArtifactInputField[];
}

/** One P1-emitted typed input (ports.ts `McpNamedField` vocabulary). */
export interface ArtifactInputField {
  readonly name: string;
  readonly field: McpSchemaField;
  readonly required: boolean;
  /** Authored `@{desc="..."}` text, verbatim; absent when not authored (MCP P4). */
  readonly description?: string;
}

// NOTE (layer vocabulary skew, harmless): this set accepts `list`/`team`
// while the compiler (`codegen/js.rs`) and the artifact loader
// (`runtime/artifact.ts`) reject them. The compiler never emits those
// kinds and MCP permissions gate every call, so the wider set admits
// nothing reachable; kept for forward-compat with future emitters.
const KNOWN_OP_KINDS: ReadonlySet<string> = new Set([
  "read",
  "list",
  "create",
  "update",
  "delete",
  "scenario",
  "team",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(where: string, detail: string): never {
  throw new Error(`mcp-registry: ${where} ${detail}`);
}

/**
 * Error vocabulary matches P1's compat layer
 * (`test/artifact-operations.test.ts`) dotted paths, so one vocabulary
 * names an entry across both layers.
 */
function checkField(raw: unknown, where: string): McpSchemaField {
  if (!isRecord(raw)) fail(where, "must be an object");
  switch (raw["kind"]) {
    case "string":
    case "integer":
    case "decimal":
    case "money":
    case "datetime":
    case "boolean":
    case "file":
      return { kind: raw["kind"] };
    case "ref": {
      const model = raw["model"];
      const requireVersion = raw["requireVersion"];
      if (typeof model !== "string" || model.length === 0) {
        fail(`${where}.model`, "must be a non-empty string");
      }
      if (typeof requireVersion !== "boolean") {
        fail(`${where}.requireVersion`, "must be a boolean");
      }
      return { kind: "ref", model, requireVersion };
    }
    case "enum": {
      const values: unknown = raw["values"];
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        !values.every((v) => typeof v === "string")
      ) {
        fail(`${where}.values`, "must be a non-empty array of strings");
      }
      return { kind: "enum", values: Object.freeze([...values]) };
    }
    default:
      fail(
        `${where}.kind`,
        `must be one of ref|string|integer|decimal|money|datetime|boolean|file|enum (got ${JSON.stringify(raw["kind"])})`,
      );
  }
}

/**
 * T19b receipt bindings (`ArtifactDeliveryDescriptor`, T04b-ratified)
 * have no `McpSchemaField` slot — delivery inputs are
 * MCP-unsuppliable — so framing excludes them exactly like
 * `checkedToMcpInputSchema` ("framing is exactly the submittable
 * allowlist"). Only well-formed entries skip: anything else falls
 * through to `checkInput` and fails loud with the usual errors
 * (name/required first, mirroring derivation ordering). The
 * descriptor grammar itself is derivation-owned (validated at
 * deploy-bake); the worker never re-derives it.
 */
function isFramingExcludedDelivery(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (typeof entry["name"] !== "string" || entry["name"].length === 0) return false;
  if (typeof entry["required"] !== "boolean") return false;
  if (!isRecord(entry["field"])) return false;
  return entry["field"]["kind"] === "delivery";
}

function checkInput(raw: unknown, where: string): McpNamedField {
  if (!isRecord(raw)) fail(where, "must be an object");
  const name = raw["name"];
  if (typeof name !== "string" || name.length === 0) {
    fail(`${where}.name`, "must be a non-empty string");
  }
  if (typeof raw["required"] !== "boolean") {
    fail(`${where}.required`, "must be a boolean");
  }
  const field = checkField(raw["field"], `${where}.field`);
  const description = raw["description"];
  if (description !== undefined && typeof description !== "string") {
    fail(`${where}.description`, "must be a string (authored `@{desc}` text)");
  }
  return {
    name,
    field,
    required: raw["required"],
    ...(description === undefined ? null : { description }),
  };
}

function checkOperation(raw: unknown, index: number): OperationDescriptor {
  const where = `operations[${index}]`;
  if (!isRecord(raw)) fail(where, "must be an object");
  const name = raw["name"];
  if (typeof name !== "string" || name.length === 0) {
    fail(`${where}.name`, "must be a non-empty string");
  }
  const kind = raw["kind"];
  if (typeof kind !== "string" || !KNOWN_OP_KINDS.has(kind)) {
    fail(
      `${where}.kind`,
      `must be one of read|list|create|update|delete|scenario|team (got ${JSON.stringify(kind)})`,
    );
  }
  if (typeof raw["description"] !== "string") {
    fail(`${where}.description`, "must be a string (authored `#` text)");
  }
  const inputs: unknown = raw["inputs"];
  if (!isRecord(inputs)) {
    fail(`${where}.inputs`, "must be an object");
  }
  const fieldsRaw: unknown = inputs["fields"];
  if (!Array.isArray(fieldsRaw)) {
    fail(`${where}.inputs.fields`, "must be an array");
  }
  const seen = new Set<string>();
  const fields: McpNamedField[] = [];
  for (const [fieldIndex, entry] of fieldsRaw.entries()) {
    if (isFramingExcludedDelivery(entry)) continue;
    const checked = checkInput(entry, `${where}.inputs.fields[${fieldIndex}]`);
    if (seen.has(checked.name)) {
      fail(where, `repeats input ${JSON.stringify(checked.name)}`);
    }
    seen.add(checked.name);
    fields.push(checked);
  }
  return {
    name,
    kind: kind as McpOperationKind,
    description: raw["description"],
    inputs: { fields: Object.freeze(fields) },
  };
}

/**
 * Read the P1 `operations[]` off the artifact. Absent (P1 not landed
 * yet) -> empty; present-but-not-an-array -> fail loud (contract
 * violation, never silently treated as supported).
 */
function readArtifactOperations(artifact: CompileArtifact): readonly OperationDescriptor[] {
  const raw: unknown = (artifact as unknown as { operations?: unknown }).operations;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    fail("operations", `must be an array (got ${typeof raw})`);
  }
  const seen = new Set<string>();
  const descriptors = raw.map((entry, index) => checkOperation(entry, index));
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      fail("operations", `repeats operation ${JSON.stringify(descriptor.name)}`);
    }
    seen.add(descriptor.name);
  }
  return Object.freeze(descriptors);
}

/* ------------------------------------------------------------------ */
/* Builders (join J3).                                                 */
/* ------------------------------------------------------------------ */

/**
 * Build the production `OperationRegistry` from the artifact's P1
 * operations: canonical names, authored `#` descriptions verbatim,
 * typed inputs. Empty until P1 lands. Malformed entries fail loud
 * naming the entry — the worker `/mcp` route contains that failure to
 * a 500 on `/mcp` (pages keep serving).
 */
export function createArtifactRegistry(artifact: CompileArtifact): OperationRegistry {
  const descriptors = readArtifactOperations(artifact);
  return {
    list: (_app: unknown): readonly OperationDescriptor[] => {
      void _app;
      return descriptors;
    },
  };
}

/**
 * Deploy-baked derived inputs by operation, as staged by the P-B
 * deploy join (`worker/derived-inputs.js`): each value is the REAL
 * interfaces derivation (`catalogFromArtifactOperations`) for the
 * staged artifact, computed at bundle time. The worker serves the
 * data verbatim after a structural shape check — it never
 * re-derives (no parallel engine; the bundle-time derivation is
 * the single rule).
 */
export type BakedDerivedInputs = Readonly<Record<string, DerivedOperationInputs>>;

const BAKED_DERIVED_OP_KINDS: ReadonlySet<string> = new Set([
  "read",
  "create",
  "update",
  "delete",
  "scenario",
]);

/**
 * Structural shape check on deploy-baked derived inputs (transport
 * skew only — key-set match, version match, entry shapes). The
 * derivation rule itself ran at bundle time; this gate never
 * re-implements it.
 */
function checkBakedDerivedInputs(
  raw: unknown,
  artifact: CompileArtifact,
  shapeNames: ReadonlySet<string>,
): Map<string, DerivedOperationInputs> {
  if (!isRecord(raw)) fail("derived-inputs", "must be an object keyed by operation");
  const checked = new Map<string, DerivedOperationInputs>();
  for (const [operation, entry] of Object.entries(raw)) {
    const where = `derived-inputs[${JSON.stringify(operation)}]`;
    if (!isRecord(entry)) fail(where, "must be an object");
    if (entry["operation"] !== operation) {
      fail(where, `operation ${JSON.stringify(entry["operation"])} does not match its key`);
    }
    if (typeof entry["kind"] !== "string" || !BAKED_DERIVED_OP_KINDS.has(entry["kind"])) {
      fail(where, `kind must be one of read|create|update|delete|scenario (got ${JSON.stringify(entry["kind"])})`);
    }
    if (entry["artifactVersion"] !== artifact.artifact_version) {
      fail(
        where,
        `artifactVersion ${JSON.stringify(entry["artifactVersion"])} does not match the staged artifact ` +
          `${JSON.stringify(artifact.artifact_version)} (stale derivation)`,
      );
    }
    if (!shapeNames.has(operation)) {
      fail(where, "names no operation in the staged artifact (bake skew)");
    }
    const inputs: unknown = entry["inputs"];
    if (!Array.isArray(inputs)) fail(`${where}.inputs`, "must be an array");
    for (const [index, input] of inputs.entries()) {
      const inputWhere = `${where}.inputs[${index}]`;
      if (!isRecord(input)) fail(inputWhere, "must be an object");
      if (typeof input["name"] !== "string" || input["name"] === "") {
        fail(`${inputWhere}.name`, "must be a non-empty string");
      }
      if (typeof input["kind"] !== "string" || input["kind"] === "") {
        fail(`${inputWhere}.kind`, "must be a non-empty string");
      }
      if (typeof input["required"] !== "boolean") {
        fail(`${inputWhere}.required`, "must be a boolean");
      }
    }
    checked.set(operation, entry as unknown as DerivedOperationInputs);
  }
  for (const name of shapeNames) {
    if (!checked.has(name)) {
      fail(`derived-inputs[${JSON.stringify(name)}]`, "missing derivation for a staged operation (bake skew)");
    }
  }
  return checked;
}

/**
 * Build the production `SchemaCatalog` from the SAME artifact
 * operations, keeping the registry/catalog views consistent (the MCP
 * server requires it: discovery renders from descriptors while the
 * closed-inputs check reads the catalog). `allowed`/`required` derive
 * from the typed fields in order, minus T19b receipt bindings
 * (framing is exactly the submittable allowlist, per
 * `deriveOperationShape`); `operation_id` framing is stripped
 * before the check, so it never appears here.
 *
 * `baked` carries the deploy-baked E1 channel (`BakedDerivedInputs`
 * via `AssemblyDeps.mcp.derivedInputs`): when present the catalog
 * also serves `derivedFor`, so production MCP dispatch runs the
 * same bound checker as HTTP (equal authority); when absent the
 * catalog is framing-only (E1 legacy behavior, byte-identical
 * shape to before).
 */
export function createArtifactCatalog(artifact: CompileArtifact, baked?: BakedDerivedInputs): SchemaCatalog {
  const shapes = new Map<string, OperationInputShape>();
  for (const descriptor of readArtifactOperations(artifact)) {
    const allowed: string[] = [];
    const required: string[] = [];
    for (const named of descriptor.inputs.fields) {
      allowed.push(named.name);
      if (named.required) required.push(named.name);
    }
    shapes.set(
      descriptor.name,
      { allowed: Object.freeze(allowed), required: Object.freeze(required) },
    );
  }
  const shapeFor = (operation: string): OperationInputShape | null => shapes.get(operation) ?? null;
  if (baked === undefined) return { shapeFor };
  const derived = checkBakedDerivedInputs(baked, artifact, new Set(shapes.keys()));
  return {
    shapeFor,
    derivedFor: (operation: string): DerivedOperationInputs | null => derived.get(operation) ?? null,
  };
}

/**
 * INTERIM deny-closed permissions (join J2 pending: L3 grants are not
 * available to the worker yet, so no per-operation grant recheck can
 * run). Denies every discover and every call — never fail-open. The
 * worker assembly uses this unless `AssemblyDeps.mcp.permissions` is
 * supplied (tests supply an allow-all double; the L3 join supplies the
 * real grant rechecks). DOCUMENTED LIMITATION: with this adapter live,
 * `tools/list` is empty and every `tools/call` answers
 * `isError`-forbidden even for valid grants; see
 * `implementation/evidence/mcp-p2.md`.
 */
export function createDenyClosedMcpPermissions(): McpPermissions {
  return {
    canDiscover: (_identity: ResolvedIdentity, _operation: string): boolean => {
      void _identity;
      void _operation;
      return false;
    },
    canCall: (_identity: ResolvedIdentity, _operation: string): boolean => {
      void _identity;
      void _operation;
      return false;
    },
  };
}
