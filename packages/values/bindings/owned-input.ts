// Private owned JSON input: parser token + controlled lineage (V03.3).
//
// The owned parser calls an unchanged capped reader (injected: the host
// `readCappedBody`), a default TextDecoder and JSON.parse, then records
// provenance in a WeakMap BEFORE the token is exposed. Token creation
// performs no semantic traversal, plan selection, conversion or budget
// check: scalar roots, deep nests and duplicate keys tokenize exactly
// as parsed. Only tokens enter owned execution: there is no
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

/** Controlled data definitions: parsed data only, no host envelope. */
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

/**
 * Parses a JSON request body into an owned token. Reader errors (caps,
 * cancellation) propagate untouched by identity. Empty and malformed
 * bodies report the host validation stage. The parsed value is stored
 * as produced: no traversal, validation, conversion or budget check.
 */
export async function parseOwnedJsonBody(
  request: Request,
  readBody: CappedBodyReader,
  maxBytes: number = OWNED_JSON_MAX_BYTES,
): Promise<OwnedJsonToken> {
  const bytes = await readBody(request, maxBytes);
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
  const token = new OwnedJsonToken();
  lineage.set(token, { bytes, text, value, byteLength: bytes.byteLength });
  Object.freeze(token);
  return token;
}

/**
 * Canonical bridge handoff: the only consumer of owned tokens. Returns
 * the recorded data with original enumeration/duplicate semantics.
 */
export function readOwnedJson(token: OwnedJsonToken): OwnedJsonRecord {
  return resolve(token);
}

/** Controlled text derivative: decoded body text, no host fields. */
export function ownedJsonText(token: OwnedJsonToken): string {
  return resolve(token).text;
}

/** Controlled value derivative: parsed JSON value as produced. */
export function ownedJsonValue(token: OwnedJsonToken): unknown {
  return resolve(token).value;
}
