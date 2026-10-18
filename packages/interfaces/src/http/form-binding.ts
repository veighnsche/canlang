/** Host-key integrity for one rendered source form; never a permission grant. */
import { base64UrlToBytes, bytesToBase64Url, sha256HexText } from '@canlang/identity';
import type { ClosedInputs } from '@canlang/contracts';
import { encodeValue } from '@canlang/values';
import type { CsvReviewBindingContext, SourceFormBindingContext, SourceFormBindings } from '../ports.js';
import { checkBoundArguments } from '../mcp/schemas.js';
import { validateOperationId } from '../envelope/validate.js';

const DOMAIN = 'can-source-form-binding';
const VERSION = 1;
const LIFETIME_MS = 15 * 60 * 1000;
const MAX_TOKEN_CHARS = 32_768;
const CSV_DOMAIN = 'can-csv-review-binding';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validCsvContext(context: CsvReviewBindingContext): boolean {
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  return record(context) && text(context.appId) && text(context.sessionToken) && text(context.operation) &&
    typeof context.reviewDigest === 'string' && /^[0-9a-f]{64}$/.test(context.reviewDigest) &&
    Number.isSafeInteger(context.nowMs) && context.nowMs >= 0 && Number.isSafeInteger(context.nowMs + LIFETIME_MS) &&
    record(context.identity) && record(context.identity.actor) && text(context.identity.actor.user_id) &&
    record(context.identity.binding) && context.identity.binding.kind === 'session' && text(context.identity.binding.session_id) &&
    (context.identity.team === null || (record(context.identity.team) && text(context.identity.team.team_id)));
}

function validContext(context: SourceFormBindingContext): boolean {
  return record(context) && record(context.derived) &&
    typeof context.appId === 'string' && context.appId !== '' &&
    typeof context.sessionToken === 'string' && context.sessionToken !== '' &&
    typeof context.operationId === 'string' && context.operationId !== '' &&
    Number.isSafeInteger(context.nowMs) && context.nowMs >= 0 &&
    Number.isSafeInteger(context.nowMs + LIFETIME_MS) &&
    ['create', 'update', 'scenario'].includes(context.derived.kind);
}

/** Bind normalized singular refs with their observed expected versions. */
function validSelection(context: SourceFormBindingContext, bound: unknown, editable: unknown): bound is ClosedInputs {
  if (!record(bound) || !Array.isArray(editable) || editable.some(name => typeof name !== 'string') ||
      new Set(editable).size !== editable.length || Object.keys(bound).length === 0) return false;
  const declared = new Map(context.derived.inputs.map(input => [input.name, input]));
  for (const name of Object.keys(bound)) {
    const input = declared.get(name), value = bound[name];
    if (input?.kind !== 'ref' || input.array !== undefined ||
        !record(value) || Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, 'id') || !Object.hasOwn(value, 'version')) return false;
    try {
      if (typeof value['version'] !== 'string' || encodeValue('int', BigInt(value['version'])) !== value['version']) return false;
    } catch { return false; }
  }
  if (checkBoundArguments(context.derived, bound) !== null) return false;
  return editable.every(name => declared.has(name) && declared.get(name)?.kind !== 'delivery' && !Object.hasOwn(bound, name));
}

/** Require the library's canonical spelling, including unused base64 tail bits. */
function canonicalBytes(value: string): Uint8Array | null {
  const bytes = base64UrlToBytes(value);
  return bytes !== null && bytesToBase64Url(bytes) === value ? bytes : null;
}

/** Configure a stable host-private key, never a session bearer or public CSRF token. */
export async function createSourceFormBindings(key: Uint8Array | string, revision: string): Promise<SourceFormBindings> {
  const keyBytes = typeof key === 'string' ? canonicalBytes(key) : key;
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32 || typeof revision !== 'string' || revision === '') {
    throw new TypeError('Source form bindings require a 32-byte host key and nonempty revision.');
  }
  const signingKey = await globalThis.crypto.subtle.importKey(
    'raw', keyBytes.slice(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
  const revisionHash = await sha256HexText(revision);
  const csvClaims = async (context: CsvReviewBindingContext) => ({
    domain: CSV_DOMAIN, version: VERSION, revision: revisionHash, app: context.appId,
    session: await sha256HexText(context.sessionToken), actor: context.identity.actor!.user_id,
    team: context.identity.team?.team_id ?? null, operation: context.operation, reviewDigest: context.reviewDigest,
  });
  const claims = async (context: SourceFormBindingContext) => ({
    domain: DOMAIN, version: VERSION, revision: revisionHash, app: context.appId,
    session: await sha256HexText(context.sessionToken),
    actor: context.identity.actor?.user_id ?? null, team: context.identity.team?.team_id ?? null,
    operation: context.derived.operation, schema: await sha256HexText(JSON.stringify(context.derived)),
    nonce: context.operationId,
  });
  const selectionPayloadValid = (
    parsed: Record<string, unknown>,
    expected: Record<string, unknown>,
    nowMs: number,
    retained: boolean,
  ): boolean => {
    if (Object.entries(expected).some(([name, value]) => parsed[name] !== value)) return false;
    if (!Number.isSafeInteger(parsed['issued']) || !Number.isSafeInteger(parsed['expires'])) return false;
    if ((parsed['issued'] as number) < 0 || (parsed['issued'] as number) > nowMs) return false;
    if (retained ? (parsed['expires'] as number) > nowMs : (parsed['expires'] as number) <= nowMs) return false;
    if ((parsed['expires'] as number) !== (parsed['issued'] as number) + LIFETIME_MS) return false;
    return true;
  };
  const selection = async (context: SourceFormBindingContext, token: string, retained: boolean): Promise<{ bound: ClosedInputs; editable: string[] } | null> => {
    if (!validContext(context) || typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return null;
    if (retained && !['create', 'update', 'delete', 'scenario'].includes(context.derived.kind)) return null;
    const segments = token.split('.');
    if (segments.length !== 2) return null;
    const payload = canonicalBytes(segments[0]!), signature = canonicalBytes(segments[1]!);
    if (payload === null || signature === null || signature.length !== 32 ||
        !await globalThis.crypto.subtle.verify('HMAC', signingKey, signature.slice(), payload.slice())) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) as unknown; }
    catch { return null; }
    if (!record(parsed)) return null;
    const expected = await claims(context);
    if (!selectionPayloadValid(parsed, expected, context.nowMs, retained) ||
        !validSelection(context, parsed['bound'], parsed['editable'])) return null;
    return { bound: parsed['bound'], editable: parsed['editable'] as string[] };
  };
  const restore = async (context: SourceFormBindingContext, token: string, inputs: ClosedInputs, retained: boolean): Promise<ClosedInputs | null> => {
    if (!record(inputs)) return null;
    const selected = await selection(context, token, retained);
    if (selected === null) return null;
    const editable = new Set(selected.editable);
    if (Object.keys(inputs).some(name => Object.hasOwn(selected.bound, name) || !editable.has(name))) return null;
    return Object.assign(Object.create(null) as ClosedInputs, inputs, selected.bound);
  };
  const seal: SourceFormBindings['seal'] = async (context, bound, editable) => {
    if (Object.hasOwn(context, 'occurrence') && (typeof context.occurrence !== 'string' ||
        !/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])+$/.test(context.occurrence))) {
      throw new TypeError('Source form occurrence must be a nonempty well-formed string.');
    }
    if (!validContext(context) || !validSelection(context, bound, editable)) {
      throw new TypeError('Source form bindings require declared singular refs with observed versions and disjoint editable inputs.');
    }
    const refs = Object.fromEntries(Object.keys(bound).sort().map(name => {
      const value = bound[name];
      const ref = value as { id: string; version: string };
      return [name, { id: ref.id, version: ref.version }];
    }));
    const selectedEditable = [...editable].sort();
    const currentClaims = await claims(context);
    const payload = new TextEncoder().encode(JSON.stringify({
      ...currentClaims, issued: context.nowMs, expires: context.nowMs + LIFETIME_MS, bound: refs, editable: selectedEditable,
    }));
    const signature = await globalThis.crypto.subtle.sign('HMAC', signingKey, payload);
    const token = `${bytesToBase64Url(payload)}.${bytesToBase64Url(new Uint8Array(signature))}`;
    if (token.length > MAX_TOKEN_CHARS) throw new TypeError('Source form binding exceeds the token size limit.');
    const { nonce: _nonce, ...bindingContext } = currentClaims;
    void _nonce;
    const comparison = context.occurrence === undefined ? {} : { occurrence: context.occurrence };
    const identity = await sha256HexText(JSON.stringify({ ...bindingContext, ...comparison, bound: refs, editable: selectedEditable }));
    const boundIds = Object.fromEntries(Object.entries(refs).map(([name, ref]) => [name, { id: ref.id }]));
    const draftIdentity = await sha256HexText(JSON.stringify({ ...bindingContext, ...comparison, bound: boundIds, editable: selectedEditable }));
    return { token, identity, draftIdentity };
  };
  return {
    csvReview: {
      async seal(context) {
        if (!validCsvContext(context)) throw new TypeError('CSV review bindings require finite trusted session context and a SHA-256 digest.');
        const payload = new TextEncoder().encode(JSON.stringify({
          ...await csvClaims(context), issued: context.nowMs, expires: context.nowMs + LIFETIME_MS,
        }));
        const signature = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', signingKey, payload));
        const token = `${bytesToBase64Url(payload)}.${bytesToBase64Url(signature)}`;
        if (token.length > MAX_TOKEN_CHARS) throw new TypeError('CSV review binding exceeds the token size limit.');
        return token;
      },
      async verify(context, token) {
        if (!validCsvContext(context) || typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return null;
        const segments = token.split('.');
        if (segments.length !== 2) return null;
        const payload = canonicalBytes(segments[0]!), signature = canonicalBytes(segments[1]!);
        if (payload === null || signature === null || signature.length !== 32 ||
            !await globalThis.crypto.subtle.verify('HMAC', signingKey, signature.slice(), payload.slice())) return null;
        let parsed: unknown, serialized: string;
        try { serialized = new TextDecoder('utf-8', { fatal: true }).decode(payload); parsed = JSON.parse(serialized) as unknown; }
        catch { return null; }
        if (!record(parsed) || !Number.isSafeInteger(parsed['issued']) || !Number.isSafeInteger(parsed['expires']) ||
            (parsed['issued'] as number) < 0 || (parsed['issued'] as number) > context.nowMs ||
            (parsed['expires'] as number) <= context.nowMs ||
            (parsed['expires'] as number) !== (parsed['issued'] as number) + LIFETIME_MS) return null;
        // Exact serialization closes the payload and its canonical key order.
        return serialized === JSON.stringify({ ...await csvClaims(context), issued: parsed['issued'], expires: parsed['expires'] })
          ? parsed['expires'] as number : null;
      },
    },
    seal,
    async renew(context, token, operationId) {
      if (!validContext(context) || typeof operationId !== 'string' || operationId === context.operationId || validateOperationId(operationId, { nowMs: () => context.nowMs }) !== null) return null;
      const selected = await selection(context, token, false);
      if (selected === null) return null;
      return (await seal({ ...context, operationId }, selected.bound, selected.editable)).token;
    },
    restore: (context, token, inputs) => restore(context, token, inputs, false),
    restoreRetained: (context, token, inputs) => restore(context, token, inputs, true),
  };
}
