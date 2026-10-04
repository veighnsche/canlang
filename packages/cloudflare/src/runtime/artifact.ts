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

const CALLABLE_KINDS: ReadonlySet<string> = new Set([
  "operation",
  "pure",
  "rule",
  "handler",
  "migration",
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
