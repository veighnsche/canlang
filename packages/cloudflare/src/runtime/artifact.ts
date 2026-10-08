/**
 * B1 artifact loader: read + strictly validate one `can compile`
 * CompileArtifact v1 JSON file (contract in
 * `@canlang/contracts` artifact.ts).
 *
 * Validation is total and loud: the first violation throws a precise
 * `Error` naming the file and the offending field. Unknown callable
 * kinds, bad `requires` entries, and malformed modules are never
 * silently treated as supported.
 */
import { readFileSync } from "node:fs";
import type { CompileArtifact } from "@canlang/contracts";

export interface LoadedArtifact {
  artifact: CompileArtifact;
  sourcePath: string;
}

/**
 * Compiled-identity expectation: the toolchain + source facts a genuine
 * `can compile` artifact must bind (the T21 pinned identity rule).
 *
 * Derived from the artifact contract (`ArtifactSource`: "Lowercase hex
 * SHA-256 of the compiled bytes") plus the compiler's version stamps:
 * identity is (source path, source bytes, toolchain version, toolchain
 * language version). Fixture artifacts (`tool_version: "e2e-fixture/…"`,
 * `language_version: "handbuilt/…"`) can never satisfy the version
 * equalities, and any byte drift fails the hash binding.
 */
export interface CompiledIdentityExpectation {
  /** Exact path string handed to the toolchain (recorded verbatim). */
  readonly sourcePath: string;
  /** Lowercase hex SHA-256 of the exact bytes handed to the toolchain. */
  readonly sourceSha256: string;
  /** Toolchain version (`can --version`); matched by exact equality. */
  readonly toolVersion: string;
  /** Toolchain language version (`can --version`); matched exactly. */
  readonly languageVersion: string;
}

/**
 * Assert an artifact is the genuine product of compiling `expected` with
 * the toolchain that stamped `expected.toolVersion`/`languageVersion`.
 * Each violated binding throws a precise `compiled-identity` error naming
 * the binding; hand-built fixtures fail the version equalities first.
 * Call after `loadArtifactFile`/`parseArtifactText` (which enforce the
 * structural contract); this enforces provenance on top of structure.
 */
export function assertCompiledIdentity(
  artifact: CompileArtifact,
  expected: CompiledIdentityExpectation,
): void {
  if (artifact.artifact_version !== 1) {
    throw new Error(
      `compiled-identity: artifact_version ${JSON.stringify(artifact.artifact_version)} is not 1`,
    );
  }
  if (artifact.language_version !== expected.languageVersion) {
    throw new Error(
      `compiled-identity: language_version ${JSON.stringify(artifact.language_version)} ` +
        `is not the toolchain language ${JSON.stringify(expected.languageVersion)}`,
    );
  }
  if (artifact.tool_version !== expected.toolVersion) {
    throw new Error(
      `compiled-identity: tool_version ${JSON.stringify(artifact.tool_version)} ` +
        `is not the toolchain version ${JSON.stringify(expected.toolVersion)}`,
    );
  }
  const source0 = artifact.sources[0];
  if (source0 === undefined) {
    throw new Error("compiled-identity: artifact has no sources; sources[0] must bind the origin");
  }
  if (source0.path !== expected.sourcePath) {
    throw new Error(
      `compiled-identity: sources[0].path ${JSON.stringify(source0.path)} ` +
        `is not the compiled path ${JSON.stringify(expected.sourcePath)}`,
    );
  }
  if (source0.sha256 !== expected.sourceSha256) {
    throw new Error(
      `compiled-identity: sources[0].sha256 ${JSON.stringify(source0.sha256)} ` +
        `does not match the compiled bytes ${JSON.stringify(expected.sourceSha256)}`,
    );
  }
}

const CALLABLE_KINDS: ReadonlySet<string> = new Set([
  "operation",
  "pure",
  "rule",
  "handler",
  "migration",
]);
// Compiler-emitted operation kinds only (`ArtifactOperationKind`):
// `list`/`team` have no `.can` source and never appear here.
const OPERATION_KINDS: ReadonlySet<string> = new Set([
  "read",
  "create",
  "update",
  "delete",
  "scenario",
]);
const OPERATION_FIELD_KINDS: ReadonlySet<string> = new Set([
  "ref",
  "string",
  "integer",
  "decimal",
  "money",
  "datetime",
  "duration",
  "user",
  "boolean",
  "file",
  "enum",
  "nominal",
  // T15b provider receipt bindings (T04b-ratified
  // `ArtifactDeliveryDescriptor`): valid artifact members, carried
  // through for the registry (which excludes them from framing)
  // and the deploy-baked derived channel (which serves them).
  "delivery",
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function fail(path: string, detail: string): never {
  throw new Error(`artifact ${path}: ${detail}`);
}

function checkModule(value: unknown, where: string, path: string): void {
  if (!isRecord(value)) fail(path, `${where} must be an object`);
  if (!isNonEmptyString(value.path)) fail(path, `${where}.path must be a non-empty string`);
  if (typeof value.js !== "string") fail(path, `${where}.js must be a string`);
  if (!isRecord(value.map)) fail(path, `${where}.map must be an object`);
  if (value.map.version !== 3) {
    fail(path, `${where}.map.version must be 3 (got ${JSON.stringify(value.map.version)})`);
  }
}

export function loadArtifactFile(path: string): LoadedArtifact {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(path, `cannot read file: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseArtifactText(text, path);
}

/**
 * Validate artifact JSON text with the exact `loadArtifactFile` rules.
 * `sourcePath` names the origin in errors (a file path, or a
 * `compiled:<source>` toolchain label). File readers use
 * `loadArtifactFile`; toolchain-stdout readers (the T21 e2e loader) use
 * this — one validation body, never two loader semantics.
 */
export function parseArtifactText(text: string, sourcePath: string): LoadedArtifact {
  const path = sourcePath;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(path, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) fail(path, "root must be a JSON object");

  if (parsed.artifact_version !== 1) {
    fail(path, `unsupported artifact_version ${JSON.stringify(parsed.artifact_version)} (want 1)`);
  }
  if (!isNonEmptyString(parsed.language_version)) {
    fail(path, "language_version must be a non-empty string");
  }
  if (!isNonEmptyString(parsed.tool_version)) {
    fail(path, "tool_version must be a non-empty string");
  }

  if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    fail(path, "sources must be a non-empty array");
  }
  const source0: unknown = parsed.sources[0];
  if (!isRecord(source0)) fail(path, "sources[0] must be an object");
  if (!isNonEmptyString(source0.path)) {
    fail(path, "sources[0].path must be a non-empty string");
  }
  if (typeof source0.sha256 !== "string" || !SHA256_HEX.test(source0.sha256)) {
    fail(path, "sources[0].sha256 must be 64-char lowercase hex");
  }

  if (!Array.isArray(parsed.modules) || parsed.modules.length === 0) {
    fail(path, "modules must be a non-empty array; modules[0] is the entrypoint");
  }
  const modulePaths = new Set<string>();
  for (const [index, module] of parsed.modules.entries()) {
    checkModule(module, `modules[${index}]`, path);
    modulePaths.add((module as { path: string }).path);
  }

  if (!Array.isArray(parsed.callables)) fail(path, "callables must be an array");
  for (const [index, callable] of parsed.callables.entries()) {
    const where = `callables[${index}]`;
    if (!isRecord(callable)) fail(path, `${where} must be an object`);
    if (!isNonEmptyString(callable.id)) {
      fail(path, `${where}.id must be a non-empty string`);
    }
    if (typeof callable.kind !== "string" || !CALLABLE_KINDS.has(callable.kind)) {
      fail(
        path,
        `${where}.kind must be one of operation|pure|rule|handler|migration ` +
          `(got ${JSON.stringify(callable.kind)})`,
      );
    }
    if (!isNonEmptyString(callable.module)) {
      fail(path, `${where}.module must be a non-empty string`);
    }
    if (!modulePaths.has(callable.module)) {
      fail(path, `${where}.module ${JSON.stringify(callable.module)} names no modules[] entry`);
    }
    if (!isNonEmptyString(callable.export)) {
      fail(path, `${where}.export must be a non-empty string`);
    }
    if (callable.inputStyle !== undefined &&
        (callable.inputStyle !== "parameters" || callable.kind !== "operation" ||
         !Array.isArray(parsed.requires) || !parsed.requires.some((requirement) => isRecord(requirement) &&
           requirement.capability === "state.parameters" && typeof requirement.min_version === "number" && requirement.min_version >= 1) ||
         !Array.isArray(parsed.operations) || !parsed.operations.some((operation) =>
           isRecord(operation) && operation.name === callable.id && operation.kind === "scenario"))) {
      fail(path, `${where}.inputStyle must be parameters on a scenario operation callable`);
    }
    const member: unknown = callable.member;
    if (
      !Array.isArray(member) ||
      member.length === 0 ||
      !member.every((segment) => typeof segment === "string" && segment.length > 0)
    ) {
      fail(
        path,
        `${where}.member for callable ${JSON.stringify(callable.id)} must be a non-empty ` +
          `array of non-empty strings (registry path into canApp()); ` +
          "recompile with the fixed `can compile`",
      );
    }
  }

  // MCP P1 descriptors are additive: artifacts compiled before P1
  // carry no `operations` key and must still load. A present key
  // validates strictly; unknown kinds are rejected loudly.
  if (parsed.operations !== undefined) {
    if (!Array.isArray(parsed.operations)) fail(path, "operations must be an array");
    const seenOperations = new Set<string>();
    for (const [index, operation] of parsed.operations.entries()) {
      const where = `operations[${index}]`;
      if (!isRecord(operation)) fail(path, `${where} must be an object`);
      if (!isNonEmptyString(operation.name)) {
        fail(path, `${where}.name must be a non-empty string`);
      }
      if (seenOperations.has(operation.name)) {
        fail(path, `operations repeats operation ${JSON.stringify(operation.name)}`);
      }
      seenOperations.add(operation.name);
      if (typeof operation.kind !== "string" || !OPERATION_KINDS.has(operation.kind)) {
        fail(
          path,
          `${where}.kind must be one of read|create|update|delete|scenario ` +
            `(got ${JSON.stringify(operation.kind)})`,
        );
      }
      if (typeof operation.description !== "string") {
        fail(path, `${where}.description must be a string`);
      }
      const inputs: unknown = operation.inputs;
      if (!isRecord(inputs)) fail(path, `${where}.inputs must be an object`);
      const fields: unknown = inputs.fields;
      if (!Array.isArray(fields)) fail(path, `${where}.inputs.fields must be an array`);
      const seenFields = new Set<string>();
      for (const [fieldIndex, field] of fields.entries()) {
        const fieldWhere = `${where}.inputs.fields[${fieldIndex}]`;
        if (!isRecord(field)) fail(path, `${fieldWhere} must be an object`);
        if (!isNonEmptyString(field.name)) {
          fail(path, `${fieldWhere}.name must be a non-empty string`);
        }
        if (seenFields.has(field.name)) {
          fail(path, `${where} repeats input ${JSON.stringify(field.name)}`);
        }
        seenFields.add(field.name);
        if (typeof field.required !== "boolean") {
          fail(path, `${fieldWhere}.required must be a boolean`);
        }
        // MCP P4 input descriptions are additive: old artifacts carry
        // no `description` key and must still load. A present key
        // must be the verbatim authored string.
        if (field.description !== undefined && typeof field.description !== "string") {
          fail(path, `${fieldWhere}.description must be a string`);
        }
        const schema: unknown = field.field;
        if (!isRecord(schema)) fail(path, `${fieldWhere}.field must be an object`);
        if (typeof schema.kind !== "string" || !OPERATION_FIELD_KINDS.has(schema.kind)) {
          fail(
            path,
            `${fieldWhere}.field.kind must be one of ` +
              `ref|string|integer|decimal|money|datetime|duration|user|boolean|file|enum|nominal|delivery ` +
              `(got ${JSON.stringify(schema.kind)})`,
          );
        }
        if (schema.kind === "ref") {
          if (!isNonEmptyString(schema.model)) {
            fail(path, `${fieldWhere}.field.model must be a non-empty string`);
          }
          if (typeof schema.requireVersion !== "boolean") {
            fail(path, `${fieldWhere}.field.requireVersion must be a boolean`);
          }
        }
        if (schema.kind === "enum") {
          const values: unknown = schema.values;
          if (
            !Array.isArray(values) ||
            values.length === 0 ||
            !values.every((value) => typeof value === "string")
          ) {
            fail(path, `${fieldWhere}.field.values must be a non-empty array of strings`);
          }
        }
        if (schema.kind === "nominal" && !isNonEmptyString(schema.name)) {
          fail(path, `${fieldWhere}.field.name must be a non-empty nominal name`);
        }
        if (schema.kind === "delivery") {
          // T15b `ArtifactDeliveryDescriptor` (T04b-ratified):
          // structural presence only. Send-target identity and
          // version fencing are semantic (derivation-owned,
          // enforced at deploy-bake), never re-derived here — this
          // check stays strictly weaker than the derivation, so
          // deploy-valid descriptors always load.
          if (!isNonEmptyString(schema.capability)) {
            fail(path, `${fieldWhere}.field.capability must be a non-empty string`);
          }
          if (!isNonEmptyString(schema.operation)) {
            fail(path, `${fieldWhere}.field.operation must be a non-empty string`);
          }
          if (schema.judgment === true ? !isNonEmptyString(schema.version) : typeof schema.version !== "number") {
            fail(path, `${fieldWhere}.field.version must be ${schema.judgment === true ? 'exact int64 text for a judgment' : 'a number'}`);
          }
          const result: unknown = schema.result;
          if (!isRecord(result)) {
            fail(path, `${fieldWhere}.field.result must be an object`);
          }
          if (!isNonEmptyString(result.name)) {
            fail(path, `${fieldWhere}.field.result.name must be a non-empty string`);
          }
          const leaves: unknown = result.fields;
          if (
            !Array.isArray(leaves) ||
            !leaves.every(
              (leaf): boolean =>
                isRecord(leaf) && isNonEmptyString(leaf.name) && typeof leaf.type === "string",
            )
          ) {
            fail(path, `${fieldWhere}.field.result.fields must be an array of {name, type} leaves`);
          }
        }
      }
    }
  }

  // Lifecycle metadata is executable policy: malformed metadata must not
  // disappear during downstream descriptor conversion.
  if (Array.isArray(parsed.models)) {
    for (const [modelIndex, model] of parsed.models.entries()) {
      if (!isRecord(model) || !Array.isArray(model.fields)) continue;
      for (const [fieldIndex, field] of model.fields.entries()) {
        if (!isRecord(field) || field.machine === undefined) continue;
        const where = `models[${modelIndex}].fields[${fieldIndex}].machine`;
        const machine = field.machine;
        if (!isRecord(machine) || !Array.isArray(machine.states) || machine.states.length === 0 ||
            !machine.states.every(isNonEmptyString) || new Set(machine.states).size !== machine.states.length ||
            !isNonEmptyString(machine.initial) || !machine.states.includes(machine.initial) ||
            !Array.isArray(machine.transitions)) fail(path, `${where} requires states, initial and transitions`);
        const states = machine.states;
        if (field.required !== false || field.serverOnly !== false || field.nullable === true || field.array !== undefined ||
            !isRecord(field.field) || field.field.kind !== "enum" || !Array.isArray(field.field.values) ||
            field.field.values.length !== machine.states.length || field.field.values.some((state, index) => state !== states[index]) ||
            !isRecord(field.default) || field.default.kind !== "literal" || field.default.value !== machine.initial) {
          fail(path, `${where} requires a nonnullable stored enum with a literal initial default`);
        }
        for (const edge of machine.transitions) {
          if (!isRecord(edge) || !isNonEmptyString(edge.from) || !machine.states.includes(edge.from) ||
              !isNonEmptyString(edge.to) || !machine.states.includes(edge.to) || !isNonEmptyString(edge.operation)) {
            fail(path, `${where} has an invalid transition edge`);
          }
          const scenario = Array.isArray(parsed.operations) && parsed.operations.some((op) =>
            isRecord(op) && op.name === edge.operation && op.kind === "scenario");
          const handler = parsed.callables.some((callable) =>
            isRecord(callable) && callable.id === edge.operation && callable.kind === "handler");
          if (!scenario && !handler) fail(path, `${where} edge names no scenario or trusted handler`);
        }
      }
    }
  }

  if (!Array.isArray(parsed.pages)) fail(path, "pages must be an array");
  for (const [index, page] of parsed.pages.entries()) {
    const where = `pages[${index}]`;
    if (!isRecord(page)) fail(path, `${where} must be an object`);
    for (const field of ["owner", "path", "module", "export"] as const) {
      if (!isNonEmptyString(page[field])) {
        fail(path, `${where}.${field} must be a non-empty string`);
      }
    }
    if (!modulePaths.has(page.module as string)) {
      fail(path, `${where}.module ${JSON.stringify(page.module)} names no modules[] entry`);
    }
  }

  if (!Array.isArray(parsed.requires)) fail(path, "requires must be an array");
  for (const [index, requirement] of parsed.requires.entries()) {
    const where = `requires[${index}]`;
    if (!isRecord(requirement)) fail(path, `${where} must be an object`);
    if (!isNonEmptyString(requirement.capability)) {
      fail(path, `${where}.capability must be a non-empty string`);
    }
    if (!Number.isInteger(requirement.min_version) || Number(requirement.min_version) < 0) {
      fail(path, `${where}.min_version must be an integer >= 0`);
    }
  }

  if (!Array.isArray(parsed.tests)) fail(path, "tests must be an array");
  for (const [index, test] of parsed.tests.entries()) {
    const where = `tests[${index}]`;
    if (!isRecord(test)) fail(path, `${where} must be an object`);
    if (!isNonEmptyString(test.scope)) {
      fail(path, `${where}.scope must be a non-empty string`);
    }
    checkModule(test.module, `${where}.module`, path);
    if (!Array.isArray(test.fixtures) || !test.fixtures.every((f) => typeof f === "string")) {
      fail(path, `${where}.fixtures must be an array of strings`);
    }
  }

  return { artifact: parsed as unknown as CompileArtifact, sourcePath: path };
}
