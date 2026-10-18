/**
 * Generation protocol (BGI-03): version-1 JSON request/result/event
 * shapes, native capability tables with pre-launch preflight, and
 * the MCP context/content-submission contract.
 *
 * This mirrors the Rust `analysis::generation_protocol` plus the
 * capability half of `analysis::generation_config` exactly: strict
 * request validation (schema, typed operations, exactly-one
 * instruction carrier), the final result envelope plus JSONL
 * progress events, deterministic error/exit semantics, adapter
 * capability advertisement, and the small MCP shapes derived from
 * checked descriptors (server-issued targets/roles only; no caller
 * paths, no second manifest). Wire names stay snake_case on both
 * hosts so requests and envelopes are byte-compatible.
 */

import { GEN_PROTOCOL_VERSION, RUNNERS, type EffectiveRecipe, type RunnerId } from "./config.js";

/** Exit 0: the requested outcome succeeded. */
export const EXIT_OK = 0;
/** Exit 2: invalid request/config/selection. */
export const EXIT_INVALID = 2;
/** Exit 3: conflict or held lease. */
export const EXIT_CONFLICT = 3;
/** Exit 4: validation failure. */
export const EXIT_VALIDATION = 4;
/** Exit 5: runner failure. */
export const EXIT_RUNNER = 5;
/** Exit 6: unknown completion. */
export const EXIT_UNKNOWN = 6;

/** All typed v1 operations, in wire order. */
export const GEN_OPERATIONS = [
  "doctor",
  "status",
  "inspect",
  "bind",
  "generate",
  "refine",
  "retry",
  "resume",
  "diff",
  "preview",
  "validate",
  "adopt",
  "accept",
  "cancel",
  "reset",
  "rollback",
  "edit.begin",
  "edit.end",
  "lease.recover",
] as const;
/** One typed v1 operation wire name. */
export type GenOperation = (typeof GEN_OPERATIONS)[number];

/** Typed admission failure with its process exit code. */
export class ProtocolError extends Error {
  /** Process exit code (0/2/3/4/5/6 per BGEN14). */
  readonly exit: number;
  /** Machine-readable code (`unknown-operation`, ...). */
  readonly code: string;
  /** Human-actionable detail without the code prefix. */
  readonly detail: string;
  constructor(exit: number, code: string, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = "ProtocolError";
    this.exit = exit;
    this.code = code;
    this.detail = detail;
  }
  /** Admission failure exiting 2 (invalid request/config/selection). */
  static invalid(code: string, detail: string): ProtocolError {
    return new ProtocolError(EXIT_INVALID, code, detail);
  }
}

/** Validated request header: protocol v1, caller id, known operation. */
export interface RequestHeader {
  /** Caller request id (idempotency key; BGI-05/12 stores it). */
  request_id: string;
  /** Validated operation. */
  operation: GenOperation;
}

/** Shared flat recipe-resolution fields for recipe-bearing operations. */
export interface RecipeParams {
  /** Replacement settings file (relative paths resolve at `root`). */
  settings?: string;
  /** Explicit run profile selecting a complete pair. */
  profile?: string;
  /** Explicit runner (requires an explicit model in the same run). */
  runner?: string;
  /** Explicit model for the effective runner. */
  model?: string;
  /** Explicit finite attempt bound. */
  max_attempts?: number;
  /** Explicit finite per-execution timeout. */
  timeout_seconds?: number;
  /** Explicit native map replacing the recipe table wholesale. */
  native?: Record<string, string | number | boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], op: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const expected = allowed.join(", ");
      throw ProtocolError.invalid(
        "unknown-field",
        `operation \`${op}\`: unknown field \`${key}\`, expected ${expected}`,
      );
    }
  }
}

function asString(value: unknown, op: string, key: string): string {
  if (typeof value !== "string") {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\`: \`${key}\` must be a string`,
    );
  }
  return value;
}

function asOptionalString(value: unknown, op: string, key: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, op, key);
}

function asUint(value: unknown, op: string, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\`: \`${key}\` must be an unsigned 32-bit integer`,
    );
  }
  return value;
}

function asOptionalUint(value: unknown, op: string, key: string): number | undefined {
  if (value === undefined) return undefined;
  return asUint(value, op, key);
}

// Per-run limits share the TOML positive-finite domain: zero is
// outside it and refuses at admission, before any recipe
// construction or runner launch. Span offsets keep plain uints.
function asOptionalPositiveUint(value: unknown, op: string, key: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = asUint(value, op, key);
  if (parsed === 0) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\`: \`${key}\` must be a positive finite integer`,
    );
  }
  return parsed;
}

function asOptionalBool(value: unknown, op: string, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\`: \`${key}\` must be a boolean`,
    );
  }
  return value;
}

function asStringArray(value: unknown, op: string, key: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\`: \`${key}\` must be an array of strings`,
    );
  }
  return value as string[];
}

function asOptionalStringArray(
  value: unknown,
  op: string,
  key: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  return asStringArray(value, op, key);
}

function asNativeMap(
  value: unknown,
  op: string,
  key: string,
): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\`: \`${key}\` must be a flat map of scalars`,
    );
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [entry, scalar] of Object.entries(value)) {
    if (typeof scalar !== "string" && typeof scalar !== "number" && typeof scalar !== "boolean") {
      throw ProtocolError.invalid(
        "invalid-param",
        `operation \`${op}\`: native option \`${entry}\` must be a scalar string, number or boolean`,
      );
    }
    out[entry] = scalar;
  }
  return out;
}

function requireText(op: string, key: string, value: string): void {
  if (value.length === 0) {
    throw ProtocolError.invalid("invalid-param", `operation \`${op}\` needs a non-empty \`${key}\``);
  }
}

function requireNonEmpty(op: string, key: string, values: string[]): void {
  if (values.length === 0) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs a non-empty \`${key}\` list`,
    );
  }
  if (values.some((value) => value.length === 0)) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` rejects empty entries in \`${key}\``,
    );
  }
}

/** Shared recipe fields accepted by recipe-bearing operations. */
const RECIPE_KEYS = [
  "settings",
  "profile",
  "runner",
  "model",
  "max_attempts",
  "timeout_seconds",
  "native",
] as const;

function parseRecipeFields(obj: Record<string, unknown>, op: string): RecipeParams {
  // Conditional spreads keep absent fields absent under
  // `exactOptionalPropertyTypes` (explicit `undefined` is rejected).
  const settings = asOptionalString(obj["settings"], op, "settings");
  const profile = asOptionalString(obj["profile"], op, "profile");
  const runner = asOptionalString(obj["runner"], op, "runner");
  const model = asOptionalString(obj["model"], op, "model");
  const max_attempts = asOptionalPositiveUint(obj["max_attempts"], op, "max_attempts");
  const timeout_seconds = asOptionalPositiveUint(obj["timeout_seconds"], op, "timeout_seconds");
  const native = asNativeMap(obj["native"], op, "native");
  return {
    ...(settings === undefined ? {} : { settings }),
    ...(profile === undefined ? {} : { profile }),
    ...(runner === undefined ? {} : { runner }),
    ...(model === undefined ? {} : { model }),
    ...(max_attempts === undefined ? {} : { max_attempts }),
    ...(timeout_seconds === undefined ? {} : { timeout_seconds }),
    ...(native === undefined ? {} : { native }),
  };
}

/** `doctor` parameters (every field optional). */
export interface DoctorParams extends RecipeParams {
  root?: string;
}
/** `status` parameters (saved intake only; no recipe fields). */
export interface StatusParams {
  root: string;
  files: string[];
}
/** `inspect` parameters (exactly one selector, plus recipe fields). */
export interface InspectParams extends RecipeParams {
  root: string;
  unit_id?: string;
  file?: string;
  start?: number;
  end?: number;
}
/** `bind` parameters. */
export interface BindParams {
  root: string;
  file: string;
  start: number;
  end: number;
  revision: string;
  unit: string;
  /** Fork this unit's complete current group when allocating `unit: new`. */
  copy_from?: string;
}
/** `generate` parameters (exactly one scope, prepare/fresh mode). */
export interface GenerateParams extends RecipeParams {
  root: string;
  files?: string[];
  unit_ids?: string[];
  mode: string;
  accept?: boolean;
}
/** `refine` parameters (exactly one instruction carrier). */
export interface RefineParams extends RecipeParams {
  root: string;
  unit_id: string;
  instruction?: string;
  instruction_file?: string;
  instruction_stdin?: boolean;
  accept?: boolean;
}
/** `retry` parameters. */
export interface RetryParams extends RecipeParams {
  root: string;
  files: string[];
  accept?: boolean;
}
/** `resume` parameters. */
export interface ResumeParams {
  root: string;
  session_id: string;
}
/** `diff` parameters. */
export interface DiffParams {
  root: string;
  unit_id: string;
  attempt?: string;
}
/** `preview` parameters. */
export interface PreviewParams {
  root: string;
  unit_id: string;
}
/** `validate` parameters (exactly one scope). */
export interface ValidateParams {
  root: string;
  unit_id?: string;
  files?: string[];
}
/** `adopt` parameters. */
export interface AdoptParams {
  root: string;
  unit_id: string;
  files: string[];
}
/** `accept` parameters (exactly one scope). */
export interface AcceptParams {
  root: string;
  unit_id?: string;
  attempt?: string;
}
/** `cancel` parameters (exactly one scope). */
export interface CancelParams {
  root: string;
  session_id?: string;
  request?: string;
}
/** `reset` parameters (exactly one scope). */
export interface ResetParams {
  root: string;
  unit_id?: string;
  attempt?: string;
  session_id?: string;
}
/** `rollback` parameters. */
export interface RollbackParams {
  root: string;
  unit_id: string;
  revision: string;
}
/** `edit.begin` parameters. */
export interface EditBeginParams {
  root: string;
  unit_id?: string;
  paths?: string[];
}
/** `edit.end` parameters. */
export interface EditEndParams {
  root: string;
  token: string;
}
/** `lease.recover` parameters. */
export interface LeaseRecoverParams {
  root: string;
  lease: string;
}

/** Validated per-operation parameters. */
export type GenParams =
  | { readonly kind: "doctor"; readonly params: DoctorParams }
  | { readonly kind: "status"; readonly params: StatusParams }
  | { readonly kind: "inspect"; readonly params: InspectParams }
  | { readonly kind: "bind"; readonly params: BindParams }
  | { readonly kind: "generate"; readonly params: GenerateParams }
  | { readonly kind: "refine"; readonly params: RefineParams }
  | { readonly kind: "retry"; readonly params: RetryParams }
  | { readonly kind: "resume"; readonly params: ResumeParams }
  | { readonly kind: "diff"; readonly params: DiffParams }
  | { readonly kind: "preview"; readonly params: PreviewParams }
  | { readonly kind: "validate"; readonly params: ValidateParams }
  | { readonly kind: "adopt"; readonly params: AdoptParams }
  | { readonly kind: "accept"; readonly params: AcceptParams }
  | { readonly kind: "cancel"; readonly params: CancelParams }
  | { readonly kind: "reset"; readonly params: ResetParams }
  | { readonly kind: "rollback"; readonly params: RollbackParams }
  | { readonly kind: "edit.begin"; readonly params: EditBeginParams }
  | { readonly kind: "edit.end"; readonly params: EditEndParams }
  | { readonly kind: "lease.recover"; readonly params: LeaseRecoverParams };

/** One fully validated v1 request: header plus typed parameters. */
export interface ValidatedRequest {
  /** Request id and operation. */
  header: RequestHeader;
  /** Validated per-operation parameters. */
  params: GenParams;
}

function parseDoctor(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", ...RECIPE_KEYS], op);
  const root = asOptionalString(obj["root"], op, "root");
  if (root !== undefined) requireText(op, "root", root);
  return {
    kind: "doctor",
    params: {
      ...(root === undefined ? {} : { root }),
      ...parseRecipeFields(obj, op),
    },
  };
}

function parseStatus(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "files"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const files = asStringArray(obj["files"], op, "files");
  requireNonEmpty(op, "files", files);
  return { kind: "status", params: { root, files } };
}

function parseInspect(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "unit_id", "file", "start", "end", ...RECIPE_KEYS], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const unit_id = asOptionalString(obj["unit_id"], op, "unit_id");
  if (unit_id !== undefined) requireText(op, "unit_id", unit_id);
  const file = asOptionalString(obj["file"], op, "file");
  if (file !== undefined) requireText(op, "file", file);
  const start = asOptionalUint(obj["start"], op, "start");
  const end = asOptionalUint(obj["end"], op, "end");
  const byId = unit_id !== undefined;
  const bySpan = file !== undefined || start !== undefined || end !== undefined;
  if (byId === bySpan) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs exactly one selector: \`unit_id\`, or \`file\` with \`start\`/\`end\``,
    );
  }
  if (bySpan && (file === undefined || start === undefined || end === undefined)) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs \`file\`, \`start\`, and \`end\` together`,
    );
  }
  if (start !== undefined && end !== undefined && start > end) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs span START<=END, got ${start}..${end}`,
    );
  }
  return {
    kind: "inspect",
    params: {
      root,
      ...(unit_id === undefined ? {} : { unit_id }),
      ...(file === undefined ? {} : { file }),
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      ...parseRecipeFields(obj, op),
    },
  };
}

function parseBind(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "file", "start", "end", "revision", "unit", "copy_from"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const file = asString(obj["file"], op, "file");
  requireText(op, "file", file);
  const start = asUint(obj["start"], op, "start");
  const end = asUint(obj["end"], op, "end");
  const revision = asString(obj["revision"], op, "revision");
  requireText(op, "revision", revision);
  const unit = asString(obj["unit"], op, "unit");
  requireText(op, "unit", unit);
  const copy_from = obj["copy_from"] === undefined ? undefined : asString(obj["copy_from"], op, "copy_from");
  if (copy_from !== undefined) {
    requireText(op, "copy_from", copy_from);
    if (unit !== "new") throw ProtocolError.invalid("invalid-param", "bind `copy_from` requires `unit: new`");
  }
  if (start > end) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs span START<=END, got ${start}..${end}`,
    );
  }
  return { kind: "bind", params: { root, file, start, end, revision, unit, ...(copy_from === undefined ? {} : { copy_from }) } };
}

function parseGenerate(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "files", "unit_ids", "mode", "accept", ...RECIPE_KEYS], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const files = asOptionalStringArray(obj["files"], op, "files");
  const unit_ids = asOptionalStringArray(obj["unit_ids"], op, "unit_ids");
  if (files !== undefined && unit_ids === undefined) {
    requireNonEmpty(op, "files", files);
  } else if (files === undefined && unit_ids !== undefined) {
    requireNonEmpty(op, "unit_ids", unit_ids);
  } else {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs exactly one scope: \`files\` or \`unit_ids\``,
    );
  }
  const mode = asString(obj["mode"], op, "mode");
  if (mode !== "prepare" && mode !== "fresh") {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs \`mode\` "prepare" or "fresh", got ${JSON.stringify(mode)}`,
    );
  }
  const accept = asOptionalBool(obj["accept"], op, "accept");
  return {
    kind: "generate",
    params: {
      root,
      ...(files === undefined ? {} : { files }),
      ...(unit_ids === undefined ? {} : { unit_ids }),
      mode,
      ...(accept === undefined ? {} : { accept }),
      ...parseRecipeFields(obj, op),
    },
  };
}

function parseRefine(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(
    obj,
    ["root", "unit_id", "instruction", "instruction_file", "instruction_stdin", "accept", ...RECIPE_KEYS],
    op,
  );
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const unit_id = asString(obj["unit_id"], op, "unit_id");
  requireText(op, "unit_id", unit_id);
  const instruction = asOptionalString(obj["instruction"], op, "instruction");
  const instruction_file = asOptionalString(obj["instruction_file"], op, "instruction_file");
  const instruction_stdin = asOptionalBool(obj["instruction_stdin"], op, "instruction_stdin");
  const carriers =
    (instruction !== undefined ? 1 : 0) +
    (instruction_file !== undefined ? 1 : 0) +
    (instruction_stdin === true ? 1 : 0);
  if (carriers !== 1) {
    throw ProtocolError.invalid(
      "exclusive-carrier",
      `operation \`${op}\` needs exactly one instruction carrier: \`instruction\`, \`instruction_file\`, or \`instruction_stdin\``,
    );
  }
  if (instruction !== undefined && instruction.length === 0) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` rejects an empty inline \`instruction\``,
    );
  }
  if (instruction_file !== undefined && instruction_file.length === 0) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` rejects an empty \`instruction_file\` path`,
    );
  }
  const accept = asOptionalBool(obj["accept"], op, "accept");
  return {
    kind: "refine",
    params: {
      root,
      unit_id,
      ...(instruction === undefined ? {} : { instruction }),
      ...(instruction_file === undefined ? {} : { instruction_file }),
      ...(instruction_stdin === undefined ? {} : { instruction_stdin }),
      ...(accept === undefined ? {} : { accept }),
      ...parseRecipeFields(obj, op),
    },
  };
}

function parseRetry(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "files", "accept", ...RECIPE_KEYS], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const files = asStringArray(obj["files"], op, "files");
  requireNonEmpty(op, "files", files);
  const accept = asOptionalBool(obj["accept"], op, "accept");
  return {
    kind: "retry",
    params: {
      root,
      files,
      ...(accept === undefined ? {} : { accept }),
      ...parseRecipeFields(obj, op),
    },
  };
}

function parseResume(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "session_id"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const session_id = asString(obj["session_id"], op, "session_id");
  requireText(op, "session_id", session_id);
  return { kind: "resume", params: { root, session_id } };
}

function parseDiff(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "unit_id", "attempt"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const unit_id = asString(obj["unit_id"], op, "unit_id");
  requireText(op, "unit_id", unit_id);
  const attempt = asOptionalString(obj["attempt"], op, "attempt");
  return {
    kind: "diff",
    params: { root, unit_id, ...(attempt === undefined ? {} : { attempt }) },
  };
}

function parsePreview(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "unit_id"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const unit_id = asString(obj["unit_id"], op, "unit_id");
  requireText(op, "unit_id", unit_id);
  return { kind: "preview", params: { root, unit_id } };
}

function parseValidate(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "unit_id", "files"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const unit_id = asOptionalString(obj["unit_id"], op, "unit_id");
  if (unit_id !== undefined) requireText(op, "unit_id", unit_id);
  const files = asOptionalStringArray(obj["files"], op, "files");
  if (unit_id !== undefined && files === undefined) {
    // Unit scope.
  } else if (unit_id === undefined && files !== undefined) {
    requireNonEmpty(op, "files", files);
  } else {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs exactly one scope: \`unit_id\` or \`files\``,
    );
  }
  return {
    kind: "validate",
    params: {
      root,
      ...(unit_id === undefined ? {} : { unit_id }),
      ...(files === undefined ? {} : { files }),
    },
  };
}

function parseAdopt(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "unit_id", "files"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const unit_id = asString(obj["unit_id"], op, "unit_id");
  requireText(op, "unit_id", unit_id);
  const files = asStringArray(obj["files"], op, "files");
  requireNonEmpty(op, "files", files);
  return { kind: "adopt", params: { root, unit_id, files } };
}

function parseAccept(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "unit_id", "attempt"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const unit_id = asOptionalString(obj["unit_id"], op, "unit_id");
  if (unit_id !== undefined) requireText(op, "unit_id", unit_id);
  const attempt = asOptionalString(obj["attempt"], op, "attempt");
  if (attempt !== undefined) requireText(op, "attempt", attempt);
  if ((unit_id !== undefined) === (attempt !== undefined)) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs exactly one scope: \`unit_id\` or \`attempt\``,
    );
  }
  return {
    kind: "accept",
    params: {
      root,
      ...(unit_id === undefined ? {} : { unit_id }),
      ...(attempt === undefined ? {} : { attempt }),
    },
  };
}

function parseCancel(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "session_id", "request"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const session_id = asOptionalString(obj["session_id"], op, "session_id");
  if (session_id !== undefined) requireText(op, "session_id", session_id);
  const request = asOptionalString(obj["request"], op, "request");
  if (request !== undefined) requireText(op, "request", request);
  if ((session_id !== undefined) === (request !== undefined)) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs exactly one scope: \`session_id\` or \`request\``,
    );
  }
  return {
    kind: "cancel",
    params: {
      root,
      ...(session_id === undefined ? {} : { session_id }),
      ...(request === undefined ? {} : { request }),
    },
  };
}

function parseReset(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "unit_id", "attempt", "session_id"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const unit_id = asOptionalString(obj["unit_id"], op, "unit_id");
  if (unit_id !== undefined) requireText(op, "unit_id", unit_id);
  const attempt = asOptionalString(obj["attempt"], op, "attempt");
  if (attempt !== undefined) requireText(op, "attempt", attempt);
  const session_id = asOptionalString(obj["session_id"], op, "session_id");
  if (session_id !== undefined) requireText(op, "session_id", session_id);
  const selectors =
    (unit_id !== undefined ? 1 : 0) + (attempt !== undefined ? 1 : 0) + (session_id !== undefined ? 1 : 0);
  if (selectors !== 1) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs exactly one scope: \`unit_id\`, \`attempt\`, or \`session_id\``,
    );
  }
  return {
    kind: "reset",
    params: {
      root,
      ...(unit_id === undefined ? {} : { unit_id }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(session_id === undefined ? {} : { session_id }),
    },
  };
}

function parseRollback(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "unit_id", "revision"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const unit_id = asString(obj["unit_id"], op, "unit_id");
  requireText(op, "unit_id", unit_id);
  const revision = asString(obj["revision"], op, "revision");
  requireText(op, "revision", revision);
  return { kind: "rollback", params: { root, unit_id, revision } };
}

function parseEditBegin(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "unit_id", "paths"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const unit_id = asOptionalString(obj["unit_id"], op, "unit_id");
  if (unit_id !== undefined) requireText(op, "unit_id", unit_id);
  const paths = asOptionalStringArray(obj["paths"], op, "paths");
  if (unit_id === undefined && paths === undefined) {
    throw ProtocolError.invalid(
      "invalid-param",
      `operation \`${op}\` needs \`unit_id\` and/or \`paths\``,
    );
  }
  if (paths !== undefined) requireNonEmpty(op, "paths", paths);
  return {
    kind: "edit.begin",
    params: {
      root,
      ...(unit_id === undefined ? {} : { unit_id }),
      ...(paths === undefined ? {} : { paths }),
    },
  };
}

function parseEditEnd(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "token"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const token = asString(obj["token"], op, "token");
  requireText(op, "token", token);
  return { kind: "edit.end", params: { root, token } };
}

function parseLeaseRecover(obj: Record<string, unknown>, op: GenOperation): GenParams {
  checkKeys(obj, ["root", "lease"], op);
  const root = asString(obj["root"], op, "root");
  requireText(op, "root", root);
  const lease = asString(obj["lease"], op, "lease");
  requireText(op, "lease", lease);
  return { kind: "lease.recover", params: { root, lease } };
}

/**
 * Parse and validate one v1 request document: JSON object, protocol
 * version 1, non-empty request id, known operation, strictly known
 * per-operation fields, then per-operation semantic checks
 * (required selectors, exclusive instruction carriers, modes).
 */
export function parseRequest(text: string): ValidatedRequest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw ProtocolError.invalid(
      "invalid-json",
      `request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw ProtocolError.invalid(
      "invalid-json",
      "request must be a JSON object with version, request_id, and operation",
    );
  }
  const map: Record<string, unknown> = { ...value };
  if (!("version" in map)) {
    throw ProtocolError.invalid(
      "missing-param",
      'request misses `version`; the v1 dispatcher requires `"version": 1`',
    );
  }
  const version = map["version"];
  delete map["version"];
  if (version !== GEN_PROTOCOL_VERSION) {
    throw ProtocolError.invalid(
      "unsupported-version",
      `unsupported request version ${JSON.stringify(version)}; this dispatcher implements v${GEN_PROTOCOL_VERSION}`,
    );
  }
  if (!("request_id" in map)) {
    throw ProtocolError.invalid(
      "missing-param",
      "request misses `request_id`; every v1 request carries a non-empty caller id",
    );
  }
  const request_id = map["request_id"];
  delete map["request_id"];
  if (typeof request_id !== "string" || request_id.trim().length === 0) {
    throw ProtocolError.invalid("invalid-param", "request `request_id` must be a non-empty string");
  }
  if (!("operation" in map)) {
    throw ProtocolError.invalid(
      "missing-param",
      "request misses `operation`; want one of the typed v1 operations",
    );
  }
  const operation = map["operation"];
  delete map["operation"];
  if (typeof operation !== "string" || !(GEN_OPERATIONS as readonly string[]).includes(operation)) {
    throw ProtocolError.invalid(
      "unknown-operation",
      `unknown operation \`${String(operation)}\`; supported operations: ${GEN_OPERATIONS.join(", ")}`,
    );
  }
  const op = operation as GenOperation;
  const params = parseParams(op, map);
  return { header: { request_id, operation: op }, params };
}

function parseParams(operation: GenOperation, rest: Record<string, unknown>): GenParams {
  switch (operation) {
    case "doctor":
      return parseDoctor(rest, operation);
    case "status":
      return parseStatus(rest, operation);
    case "inspect":
      return parseInspect(rest, operation);
    case "bind":
      return parseBind(rest, operation);
    case "generate":
      return parseGenerate(rest, operation);
    case "refine":
      return parseRefine(rest, operation);
    case "retry":
      return parseRetry(rest, operation);
    case "resume":
      return parseResume(rest, operation);
    case "diff":
      return parseDiff(rest, operation);
    case "preview":
      return parsePreview(rest, operation);
    case "validate":
      return parseValidate(rest, operation);
    case "adopt":
      return parseAdopt(rest, operation);
    case "accept":
      return parseAccept(rest, operation);
    case "cancel":
      return parseCancel(rest, operation);
    case "reset":
      return parseReset(rest, operation);
    case "rollback":
      return parseRollback(rest, operation);
    case "edit.begin":
      return parseEditBegin(rest, operation);
    case "edit.end":
      return parseEditEnd(rest, operation);
    case "lease.recover":
      return parseLeaseRecover(rest, operation);
  }
}

/** Which carrier a validated `refine` request selected. */
export type InstructionCarrier =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "stdin" };

/** The exactly-one carrier admitted by `refine` validation. */
export function refineCarrier(params: RefineParams): InstructionCarrier {
  if (params.instruction !== undefined) return { kind: "text", text: params.instruction };
  if (params.instruction_file !== undefined) return { kind: "file", path: params.instruction_file };
  return { kind: "stdin" };
}

/**
 * Build the one final JSON result envelope for a successful
 * operation: version, request, operation, `ok: true`, the
 * operation `state`, its payload fields, and bounded next actions.
 */
export function okEnvelope(
  header: RequestHeader,
  state: string,
  payload: Record<string, unknown>,
  next: string[],
): string {
  return `${JSON.stringify({
    version: GEN_PROTOCOL_VERSION,
    request_id: header.request_id,
    operation: header.operation,
    ok: true,
    state,
    ...payload,
    next,
  })}\n`;
}

/**
 * Build the one final JSON result envelope for a failed operation:
 * version, request, operation, `ok: false`, the structured error,
 * and bounded next actions.
 */
export function errorEnvelope(
  request_id: string,
  operation: string,
  code: string,
  message: string,
  next: string[],
): string {
  return `${JSON.stringify({
    version: GEN_PROTOCOL_VERSION,
    request_id,
    operation,
    ok: false,
    state: "error",
    error: { code, message },
    next,
  })}\n`;
}

/**
 * Build one optional JSONL progress event. Progress goes to stderr
 * only, so stdout always carries exactly the final envelope; the
 * stream ends with that envelope.
 */
export function progressEvent(
  request_id: string,
  operation: string,
  phase: string,
  detail: string,
): string {
  return `${JSON.stringify({
    version: GEN_PROTOCOL_VERSION,
    request_id,
    operation,
    event: "progress",
    phase,
    detail,
  })}\n`;
}

/** Advertisement state of one required adapter capability. */
export type CapabilityStatus =
  | {
      /** Implemented by this adapter; the capability may launch. */
      readonly state: "supported";
      /** How the adapter implements this capability. */
      readonly note: string;
    }
  | {
      /** The adapter cannot provide this capability. */
      readonly state: "unsupported";
      /** Why the adapter cannot provide it. */
      readonly note: string;
    };

/** One documented native adapter control. */
export interface NativeOptionSpec {
  /** Option key as it appears in `native` maps. */
  name: string;
  /** Accepted scalar kind (`string`, `integer`, `number`, `boolean`). */
  kind: string;
  /** What the control does and how the adapter enforces it. */
  description: string;
}

/** Native capability advertisement for one runner adapter. */
export interface AdapterCapabilities {
  /** Runner id (`codex`, `muse`, `claude-code`, `opencode`). */
  id: RunnerId;
  /** Human adapter label. */
  label: string;
  /**
   * Executable names probed on PATH, in order (first hit wins).
   * BGI-06 verifies these against installed tools; the probe
   * reports the exact names it tried, never a silent pass.
   */
  probe_binaries: readonly string[];
  /** Custom generation-MCP attachment for context/submission. */
  mcp_attachment: CapabilityStatus;
  /** Enforced generator write restrictions over protected roots. */
  write_restriction: CapabilityStatus;
  /** Recorded-session resume for a still-applicable capture. */
  session_resume: CapabilityStatus;
  /** Documented native controls; unknown keys fail preflight. */
  native_options: readonly NativeOptionSpec[];
}

/** Implemented adapter capabilities; unknown native keys refuse before launch. */
export const ADAPTERS: readonly AdapterCapabilities[] = [
  {
    id: "codex",
    label: "Codex CLI",
    probe_binaries: ["codex"],
    mcp_attachment: {
      state: "supported",
      note: "Codex attaches the generation host MCP server",
    },
    write_restriction: {
      state: "supported",
      note: "Read-only sandbox denies source/current/candidate writes; isolated host tools",
    },
    session_resume: {
      state: "unsupported",
      note: "Isolated ephemeral Codex generation has no persisted session; explicit new work is required",
    },
    native_options: [{
      name: "model_reasoning_effort", kind: "string",
      description: "Explicit Codex reasoning effort: low, medium, high, xhigh, max or ultra; model support remains a native CLI gate.",
    }],
  },
  {
    id: "muse",
    label: "Muse Code",
    probe_binaries: ["muse"],
    mcp_attachment: {
      state: "unsupported",
      note: "Muse MCP attachment is not implemented",
    },
    write_restriction: {
      state: "unsupported",
      note: "Muse protected-write enforcement is not implemented",
    },
    session_resume: {
      state: "unsupported",
      note: "Muse session resume is not implemented",
    },
    native_options: [],
  },
  {
    id: "claude-code",
    label: "Claude Code",
    probe_binaries: ["claude", "claude-code"],
    mcp_attachment: {
      state: "unsupported",
      note: "Claude Code MCP attachment is not implemented",
    },
    write_restriction: {
      state: "unsupported",
      note: "Claude Code protected-write enforcement is not implemented",
    },
    session_resume: {
      state: "unsupported",
      note: "Claude Code session resume is not implemented",
    },
    native_options: [],
  },
  {
    id: "opencode",
    label: "OpenCode",
    probe_binaries: ["opencode"],
    mcp_attachment: {
      state: "unsupported",
      note: "OpenCode MCP attachment is not implemented",
    },
    write_restriction: {
      state: "unsupported",
      note: "OpenCode protected-write enforcement is not implemented",
    },
    session_resume: {
      state: "unsupported",
      note: "OpenCode session resume is not implemented",
    },
    native_options: [],
  },
];

/** Look up one adapter's capability advertisement by runner id. */
export function adapterCapabilities(runner: string): AdapterCapabilities | undefined {
  return ADAPTERS.find((adapter) => adapter.id === runner);
}

/** Typed pre-launch failure (the dispatcher maps these to exit 2). */
export class PreflightError extends Error {
  /** Machine-readable code (`unsupported-capability`, ...). */
  readonly code: string;
  /** Human-actionable detail without the code prefix. */
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = "PreflightError";
    this.code = code;
    this.detail = detail;
  }
}

function checkLaunchCapability(runner: string, what: string, status: CapabilityStatus): void {
  if (status.state === "supported") return;
  throw new PreflightError(
    "unsupported-capability",
    `runner \`${runner}\` cannot launch: ${what} is unsupported (${status.note}); refusing before launch without a direct-file fallback`,
  );
}

/**
 * Pre-launch gate for one effective recipe: the adapter must affirm
 * supported MCP attachment and enforceable write restrictions, and
 * every native key must be documented by that adapter. Unsupported
 * capabilities fail before launch, with
 * no direct-file fallback. BGI-05 runs this per compatible-recipe
 * job before spawning any runner; the dispatcher runs it during
 * admission for single-recipe execution requests.
 */
export function checkNativeOptions(recipe: EffectiveRecipe): void {
  const adapter = adapterCapabilities(recipe.runner);
  if (adapter === undefined) {
    throw new PreflightError(
      "unknown-runner",
      `unknown runner \`${recipe.runner}\`; supported runners: ${RUNNERS.join(", ")}`,
    );
  }
  for (const key of Object.keys(recipe.native)) {
    const known = adapter.native_options.some((spec) => spec.name === key);
    if (!known) {
      const documented =
        adapter.native_options.length === 0
          ? "no native options are documented yet"
          : `documented options: ${adapter.native_options.map((spec) => spec.name).join(", ")}`;
      throw new PreflightError(
        "unsupported-native-option",
        `unsupported native option \`${key}\` for runner \`${recipe.runner}\`; ${documented}`,
      );
    }
  }
  if (recipe.runner === "codex" && recipe.native["model_reasoning_effort"] !== undefined) {
    const value = recipe.native["model_reasoning_effort"];
    if (typeof value !== "string" || !["low", "medium", "high", "xhigh", "max", "ultra"].includes(value)) {
      throw new PreflightError("invalid-native-option", "Codex model_reasoning_effort must be low, medium, high, xhigh, max or ultra");
    }
  }
}

export function preflightRecipe(recipe: EffectiveRecipe): void {
  checkNativeOptions(recipe);
  const adapter = adapterCapabilities(recipe.runner)!;
  checkLaunchCapability(recipe.runner, "custom MCP attachment", adapter.mcp_attachment);
  checkLaunchCapability(recipe.runner, "enforced generator write restrictions", adapter.write_restriction);
}

/** Pre-launch gate for recorded-session resume: the launch gates plus a supported resume capability. */
export function preflightResume(recipe: EffectiveRecipe): void {
  preflightRecipe(recipe);
  const adapter = adapterCapabilities(recipe.runner);
  if (adapter === undefined) throw new PreflightError("unknown-runner", `unknown runner \`${recipe.runner}\``);
  checkLaunchCapability(recipe.runner, "recorded-session resume", adapter.session_resume);
}

/** MCP tool returning immutable checked context and allowed handles/roles. */
export const MCP_CONTEXT_TOOL = "generation_context";
/** MCP tool accepting `{target, role, content}` batches against issued handles. */
export const MCP_SUBMIT_TOOL = "generation_submit";

/** Output role admitted for one server-issued target. */
export type McpRole = "server" | "browser" | "style" | "asset" | "contributions";

/**
 * One server-issued allowed output target: an opaque session-bound
 * handle plus its admitted role. Handles are internal associations,
 * not authored prompt names and never filesystem paths; the host
 * alone maps them to candidate placement.
 */
export interface AllowedTarget {
  /** Opaque session-bound handle (grammar `[A-Za-z0-9_-]{1,128}`). */
  handle: string;
  /** The one role admitted for this handle. */
  role: McpRole;
  /** Unit kind this target serves (descriptor-derived). */
  kind: string;
  /** Server-chosen logical filename (the host maps it to paths). */
  filename: string;
}

/** Immutable checked context for one captured attempt. No secrets, no physical paths. */
export interface GenerationContext {
  /** Host-bound MCP session id. */
  session: string;
  /** Captured attempt id. */
  attempt: string;
  /** Digest of the captured source/contract closure. */
  source_digest: string;
  /** Server-issued allowed output handles/roles. */
  allowed: AllowedTarget[];
  /** Captured source, owning interfaces/theme, intents and assignment context. */
  instructions?: string;
}

/**
 * One `{target, role, content}` submission entry. Content is UTF-8
 * text or a checked base64 asset payload, never a file reference.
 */
export interface SubmissionEntry {
  /** Issued handle being submitted (never a path). */
  target: string;
  /** Role claimed for the handle (must match issuance). */
  role: string;
  /** UTF-8 code/text content (xor `content_base64`). */
  content_text?: string;
  /** Checked base64 asset payload (xor `content_text`). */
  content_base64?: string;
}

/** Typed MCP contract failure. */
export class McpError extends Error {
  /** Machine-readable code (`unknown-target`, `role-mismatch`, ...). */
  readonly code: string;
  /** Human-actionable detail without the code prefix. */
  readonly detail: string;
  constructor(code: string, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = "McpError";
    this.code = code;
    this.detail = detail;
  }
}

/** Identity-carrying unit kinds (kebab-case, shared with `unit.json`). */
export type McpUnitKind =
  | "named-trait"
  | "inline-trait"
  | "keyword"
  | "style"
  | "style-inline"
  | "view"
  | "view-style-inline";

/**
 * Admitted (role, logical filename) outputs per identity-carrying
 * unit kind, derived from checked descriptors. Views admit server,
 * browser, style, and asset outputs; styles (including view-root
 * inline styles) admit style and asset. Traits require checked contributions
 * and may submit a text-field check; pure keywords admit a server implementation.
 */
export function allowedOutputsFor(kind: McpUnitKind): ReadonlyArray<readonly [McpRole, string]> {
  switch (kind) {
    case "style":
    case "style-inline":
    case "view-style-inline":
      return [
        ["style", "style.css"],
        ["asset", "asset.bin"],
      ];
    case "view":
      return [
        ["server", "server.js"],
        ["browser", "browser.js"],
        ["style", "style.css"],
        ["asset", "asset.bin"],
      ];
    case "named-trait":
    case "inline-trait":
      return [["contributions", "contributions.can"], ["server", "server.js"]];
    case "keyword":
      return [["server", "server.js"]];
  }
}

/**
 * Opaque handle grammar: 1..=128 ASCII letters, digits, `_`, `-`.
 * Anything else (including every path shape) is not a handle.
 */
export function handleGrammarValid(handle: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(handle);
}

/** Strict base64 payload check: grammar, padding, and decode round-trip. */
function isWellFormedBase64(text: string): boolean {
  if (text.length === 0 || text.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return false;
  const pad = text.indexOf("=");
  if (pad !== -1 && !/^=*$/.test(text.slice(pad))) return false;
  try {
    return Buffer.from(text, "base64").toString("base64") === text;
  } catch {
    return false;
  }
}

/**
 * Validate one `generation_submit` batch against the issued
 * context: the session must match, the batch must be non-empty,
 * every target must be an issued handle (path-like targets refuse
 * as arbitrary paths, never as missing handles), roles must match
 * issuance, each entry carries exactly one well-formed content
 * payload, and no target repeats within the batch. Returns the
 * matched allowed targets in batch order. Cross-batch duplicate
 * detection is server state owned by the BGI-05 host.
 */
export function validateSubmissionBatch(
  context: GenerationContext,
  session: string,
  batch: SubmissionEntry[],
): AllowedTarget[] {
  if (session !== context.session) {
    throw new McpError(
      "stale-session",
      "submission session does not match the captured attempt; stale sessions refuse",
    );
  }
  if (batch.length === 0) {
    throw new McpError("empty-batch", "submission batches carry at least one entry");
  }
  const matched: AllowedTarget[] = [];
  const seen = new Set<string>();
  for (const entry of batch) {
    if (entry.target.includes("/") || entry.target.includes("\\") || entry.target.includes("..")) {
      throw new McpError(
        "arbitrary-path",
        `submission target ${JSON.stringify(entry.target)} looks like a path; submissions name only server-issued handles`,
      );
    }
    if (!handleGrammarValid(entry.target)) {
      throw new McpError(
        "unknown-target",
        `submission target ${JSON.stringify(entry.target)} is not an issued handle for this session`,
      );
    }
    const allowed = context.allowed.find((candidate) => candidate.handle === entry.target);
    if (allowed === undefined) {
      throw new McpError(
        "unknown-target",
        `submission target ${JSON.stringify(entry.target)} is not an issued handle for this session`,
      );
    }
    if (entry.role !== allowed.role) {
      throw new McpError(
        "role-mismatch",
        `submission target ${JSON.stringify(entry.target)} admits role ${JSON.stringify(allowed.role)}, got ${JSON.stringify(entry.role)}`,
      );
    }
    const hasText = entry.content_text !== undefined;
    const hasBlob = entry.content_base64 !== undefined;
    if (hasText && hasBlob) {
      throw new McpError(
        "malformed-content",
        `submission target ${JSON.stringify(entry.target)} carries both text and base64 content; exactly one is admitted`,
      );
    }
    if (!hasText && !hasBlob) {
      throw new McpError(
        "malformed-content",
        `submission target ${JSON.stringify(entry.target)} carries no content; text or base64 is required`,
      );
    }
    if (hasText && (entry.content_text as string).length === 0) {
      throw new McpError(
        "malformed-content",
        `submission target ${JSON.stringify(entry.target)} carries empty text content`,
      );
    }
    if (hasBlob && !isWellFormedBase64(entry.content_base64 as string)) {
      throw new McpError(
        "malformed-content",
        `submission target ${JSON.stringify(entry.target)} carries malformed base64 content`,
      );
    }
    if (seen.has(entry.target)) {
      throw new McpError(
        "duplicate-target",
        `submission target ${JSON.stringify(entry.target)} repeats within one batch; conflicting submissions refuse`,
      );
    }
    seen.add(entry.target);
    matched.push(allowed);
  }
  return matched;
}


