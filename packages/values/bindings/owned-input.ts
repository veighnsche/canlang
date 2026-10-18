// Private owned JSON input: parser token + controlled lineage (V03.3).
//
// The owned parser calls an unchanged capped reader (injected: the host
// `readCappedBody`), a default TextDecoder and JSON.parse, then records
// provenance in a WeakMap BEFORE the token is exposed. Reader bytes are
// copied and parser-created containers are frozen by an iterative ownership
// traversal, without semantic validation, plan selection, conversion or a
// new budget check: scalar roots, deep nests and duplicate keys retain their
// parsed content. Only tokens enter owned execution: there is no
// adopt(unknown), and forged tokens, proxies or bare values are
// rejected at the handoff.
//
// This module imports nothing from interfaces: the branch tree is stale
// there and the host reader arrives by injection. Cap/message literals
// mirror `packages/interfaces/src/http/limits.ts` (JSON_BODY_MAX_BYTES,
// 'Invalid JSON body.'); the owned-vs-host differential on main is the
// alignment proof, not a second implementation here.
export type CappedBodyReader = (request: Request, maxBytes: number) => Promise<Uint8Array>;

/** Default JSON body cap, mirroring the host JSON_BODY_MAX_BYTES. */
export const OWNED_JSON_MAX_BYTES = 1_048_576;

export type OwnedInputCode = "limit" | "validation" | "forged-token";

export class OwnedInputError extends Error {
  readonly code: OwnedInputCode;

  constructor(code: OwnedInputCode, message: string) {
    super(message);
    this.name = "OwnedInputError";
    this.code = code;
  }
}

/**
 * Opaque owned-input token. Constructible but useless without the
 * parser: only tokens recorded in the lineage map resolve.
 */
export class OwnedJsonToken {
  readonly #brand: "owned-json" = "owned-json";

  /** Reads the brand so the field is not dead weight. */
  brand(): "owned-json" {
    return this.#brand;
  }
}

/** Stable frozen record and parsed value; each bytes access returns a copy. */
export interface OwnedJsonRecord {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly value: unknown;
  readonly byteLength: number;
}

const lineage = new WeakMap<OwnedJsonToken, OwnedJsonRecord>();

function resolve(token: OwnedJsonToken): OwnedJsonRecord {
  const record = lineage.get(token);
  if (record === undefined) {
    throw new OwnedInputError("forged-token", "Owned input token is not genuine.");
  }
  return record;
}

/** Ownership-only traversal of the fresh JSON.parse tree, never arbitrary input. */
function freezeParsedContainers(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) {
      continue;
    }
    const record = current as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (typeof child === "object" && child !== null) {
        pending.push(child);
      }
    }
    Object.freeze(current);
  }
}

/**
 * Parses a JSON request body into an owned token. Reader errors (caps,
 * cancellation) propagate untouched by identity. Empty and malformed
 * bodies report the host validation stage. Parsed contents are preserved;
 * ownership freezing adds no semantic validation, conversion or depth cap.
 */
export async function parseOwnedJsonBody(
  request: Request,
  readBody: CappedBodyReader,
  maxBytes: number = OWNED_JSON_MAX_BYTES,
): Promise<OwnedJsonToken> {
  const bytes = new Uint8Array(await readBody(request, maxBytes));
  const text = new TextDecoder().decode(bytes);
  if (text.trim().length === 0) {
    throw new OwnedInputError("validation", "Invalid JSON body.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new OwnedInputError("validation", "Invalid JSON body.");
  }
  freezeParsedContainers(value);
  const token = new OwnedJsonToken();
  lineage.set(token, Object.freeze({
    get bytes(): Uint8Array { return new Uint8Array(bytes); },
    text,
    value,
    byteLength: bytes.byteLength,
  }));
  Object.freeze(token);
  return token;
}

/**
 * Canonical bridge handoff: the only consumer of owned tokens. Returns
 * the stable frozen record/value with original enumeration/duplicate
 * semantics. Bytes are an accessor returning a fresh defensive copy.
 */
export function readOwnedJson(token: OwnedJsonToken): OwnedJsonRecord {
  return resolve(token);
}

/** Tagged frame JSON consumed by the native profile seam (mirrors
 * `parse_frame` in `semantics/src/profiles.rs`). Text rides UTF-16
 * units with lone surrogates preserved; numbers ride exact f64 bits
 * (including -0 and NaN payloads); objects ride ordered key-unit
 * entries in first-insertion order. */
export type OwnedFrame =
  | { readonly t: "f64"; readonly bits: string }
  | { readonly t: "text"; readonly units: readonly number[] }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "null" }
  | { readonly t: "array"; readonly items: readonly OwnedFrame[] }
  | { readonly t: "entries"; readonly entries: ReadonlyArray<readonly [readonly number[], OwnedFrame]> };

/** Lossless UTF-16 units of one string (lone surrogates preserved). */
export function textUnits(text: string): number[] {
  const out = new Array<number>(text.length);
  for (let index = 0; index < text.length; index++) {
    out[index] = text.charCodeAt(index);
  }
  return out;
}

function f64Bits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  let hex = "";
  for (let index = 0; index < 8; index++) {
    hex += view.getUint8(index).toString(16).padStart(2, "0");
  }
  return hex;
}

function frameForValue(root: unknown): OwnedFrame {
  // Iterative over an explicit heap stack: parser-accepted depth is
  // unbounded on the host (no parser cap), so recursion here would
  // overflow the host stack before native budgets ever apply. No host
  // depth limit is imposed; the native arena enforces budgets.
  let result: OwnedFrame | undefined;
  type Cont = (frame: OwnedFrame) => void;
  const stack: Array<{ value: unknown; cont: Cont }> = [
    {
      value: root,
      cont: (frame) => {
        result = frame;
      },
    },
  ];
  while (stack.length > 0) {
    const task = stack.pop() as { value: unknown; cont: Cont };
    const value = task.value;
    if (value === null) {
      task.cont({ t: "null" });
      continue;
    }
    if (typeof value === "boolean") {
      task.cont({ t: "bool", v: value });
      continue;
    }
    if (typeof value === "number") {
      task.cont({ t: "f64", bits: f64Bits(value) });
      continue;
    }
    if (typeof value === "string") {
      task.cont({ t: "text", units: textUnits(value) });
      continue;
    }
    if (Array.isArray(value)) {
      const items = new Array<OwnedFrame>(value.length);
      task.cont({ t: "array", items });
      for (let index = value.length - 1; index >= 0; index--) {
        const at = index;
        const item: unknown = value[at];
        stack.push({
          value: item === undefined ? null : item,
          cont: (frame) => {
            items[at] = frame;
          },
        });
      }
      continue;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      const entries = new Array<readonly [readonly number[], OwnedFrame]>(keys.length);
      task.cont({ t: "entries", entries });
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        if (key === undefined) continue; // Unreachable: index < length.
        const at = index;
        const item: unknown = record[key];
        stack.push({
          value: item === undefined ? null : item,
          cont: (frame) => {
            entries[at] = [textUnits(key), frame];
          },
        });
      }
      continue;
    }
    throw new OwnedInputError("validation", "Owned frame cannot represent this value.");
  }
  return result as OwnedFrame;
}

/** Builds the owned-input frame join: the parser-owned value of a
 * genuine token encoded losslessly for `request.begin`. Forged tokens
 * refuse at lineage resolution before any encoding. */
export function ownedFrameFor(token: OwnedJsonToken): OwnedFrame {
  return frameForValue(resolve(token).value);
}

/** Builds the transport frame for a canonical wire value: plain
 * JSON-safe data such as an exact-codec canonical encoding. Lossless
 * like `ownedFrameFor`, but over a caller-held value rather than a
 * parser-owned token — callers must only pass genuine codec outputs,
 * never raw client input. */
export function frameForWireValue(value: unknown): OwnedFrame {
  return frameForValue(value);
}

/** Frames one operation call's owned arguments: the body's `inputs`
 * record plus the body's `operation_id` when present (mutations
 * carry it alongside inputs; reads carry none). Both pieces are own
 * properties of frozen parser-owned data, so the merged frame and
 * value stay parser-owned. Returns the frame for `request.begin`
 * together with its matching plain input value for the resolve
 * loop. Non-object bodies or inputs refuse before any encoding.
 *
 * Transport members named in `exclude` (for example the HTTP `_csrf`
 * field, which the canonical submitted-inputs projection consumes
 * for its check and strips before the closed-inputs check) are
 * projected out of BOTH the frame and the resolve-loop input, so the
 * native call sees exactly the protected original-stage projection —
 * still derived from this same token's raw source, never reparsed or
 * forged. Without exclusions the projection is the verbatim inputs. */
export function ownedOperationFrame(
  token: OwnedJsonToken,
  options?: { readonly exclude?: ReadonlyArray<string> },
): { frame: OwnedFrame; input: Record<string, unknown> } {
  const body: unknown = resolve(token).value;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new OwnedInputError("validation", "Owned operation body is not an object.");
  }
  const inputs: unknown = (body as Record<string, unknown>)["inputs"];
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    throw new OwnedInputError("validation", "Owned operation inputs are not an object.");
  }
  const merged: Record<string, unknown> = { ...(inputs as Record<string, unknown>) };
  for (const name of options?.exclude ?? []) delete merged[name];
  const operationId: unknown = (body as Record<string, unknown>)["operation_id"];
  if (operationId !== undefined) merged["operation_id"] = operationId;
  return { frame: frameForValue(merged), input: merged };
}

/** Derives the frame for the subvalue at `path` under a genuine
 * token: each step reads an own property (objects) or a bound index
 * (arrays) of frozen parser-owned data, so the subvalue stays
 * parser-owned without a new token. Absent steps refuse before any
 * encoding. */
export function ownedFrameAt(token: OwnedJsonToken, path: ReadonlyArray<string | number>): OwnedFrame {
  let current: unknown = resolve(token).value;
  for (const step of path) {
    if (typeof step === "number") {
      if (!Array.isArray(current) || !Number.isInteger(step) || step < 0 || step >= current.length) {
        throw new OwnedInputError("validation", "Owned frame path is absent.");
      }
      current = current[step];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        throw new OwnedInputError("validation", "Owned frame path is absent.");
      }
      if (!Object.hasOwn(current, step)) {
        throw new OwnedInputError("validation", "Owned frame path is absent.");
      }
      current = (current as Record<string, unknown>)[step];
    }
  }
  return frameForValue(current);
}

/** Controlled text derivative: decoded body text, no host fields. */
export function ownedJsonText(token: OwnedJsonToken): string {
  return resolve(token).text;
}

/** Controlled value derivative: parsed JSON value as produced. */
export function ownedJsonValue(token: OwnedJsonToken): unknown {
  return resolve(token).value;
}
