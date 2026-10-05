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

import type { CompileArtifact, ResolvedIdentity } from "@canlang/contracts";

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

/** Mirror of `SchemaCatalog` (`ports.ts:32`). */
export interface SchemaCatalog {
  shapeFor(operation: string): OperationInputShape | null;
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
 * Build the production `SchemaCatalog` from the SAME artifact
 * operations, keeping the registry/catalog views consistent (the MCP
 * server requires it: discovery renders from descriptors while the
 * closed-inputs check reads the catalog). `allowed`/`required` derive
 * from the typed fields in order; `operation_id` framing is stripped
 * before the check, so it never appears here.
 */
export function createArtifactCatalog(artifact: CompileArtifact): SchemaCatalog {
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
  return {
    shapeFor: (operation: string): OperationInputShape | null => shapes.get(operation) ?? null,
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
