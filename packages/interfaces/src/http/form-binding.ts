/** Host-key integrity for one rendered source form; never a permission grant. */
import { base64UrlToBytes, bytesToBase64Url, sha256HexText } from '@canlang/identity';
import type { ClosedInputs } from '@canlang/contracts';
import { encodeValue } from '@canlang/values';
import type { SourceFormBindingContext, SourceFormBindings } from '../ports.js';
import { checkBoundArguments } from '../mcp/schemas.js';

const DOMAIN = 'can-source-form-binding';
const VERSION = 1;
const LIFETIME_MS = 15 * 60 * 1000;
const MAX_TOKEN_CHARS = 32_768;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validContext(context: SourceFormBindingContext): boolean {
  return typeof context.appId === 'string' && context.appId !== '' &&
    typeof context.sessionToken === 'string' && context.sessionToken !== '' &&
    typeof context.operationId === 'string' && context.operationId !== '' &&
    Number.isSafeInteger(context.nowMs) && context.nowMs >= 0 &&
    Number.isSafeInteger(context.nowMs + LIFETIME_MS) &&
    ['create', 'update', 'scenario'].includes(context.derived.kind);
}

/** The first contract binds only normalized singular refs with expected versions. */
function validSelection(context: SourceFormBindingContext, bound: unknown, editable: unknown): bound is ClosedInputs {
  if (!record(bound) || !Array.isArray(editable) || editable.some(name => typeof name !== 'string') ||
      new Set(editable).size !== editable.length || Object.keys(bound).length === 0) return false;
  const declared = new Map(context.derived.inputs.map(input => [input.name, input]));
  for (const name of Object.keys(bound)) {
    const input = declared.get(name), value = bound[name];
    if (input?.kind !== 'ref' || input.versioned !== true || input.array !== undefined ||
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
  const claims = async (context: SourceFormBindingContext) => ({
    domain: DOMAIN, version: VERSION, revision: revisionHash, app: context.appId,
    session: await sha256HexText(context.sessionToken),
    actor: context.identity.actor?.user_id ?? null, team: context.identity.team?.team_id ?? null,
    operation: context.derived.operation, schema: await sha256HexText(JSON.stringify(context.derived)),
    nonce: context.operationId,
  });
  return {
    async seal(context, bound, editable) {
      if (!validContext(context) || !validSelection(context, bound, editable)) {
        throw new TypeError('Source form bindings require declared versioned refs and disjoint editable inputs.');
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
      const identity = await sha256HexText(JSON.stringify({ ...bindingContext, bound: refs, editable: selectedEditable }));
      return { token, identity };
    },
    async restore(context, token, inputs) {
      if (!validContext(context) || typeof token !== 'string' || token.length > MAX_TOKEN_CHARS || !record(inputs)) return null;
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
      if (Object.entries(expected).some(([name, value]) => parsed[name] !== value) ||
          !Number.isSafeInteger(parsed['issued']) || !Number.isSafeInteger(parsed['expires']) ||
          (parsed['issued'] as number) > context.nowMs || (parsed['expires'] as number) <= context.nowMs ||
          (parsed['expires'] as number) !== (parsed['issued'] as number) + LIFETIME_MS ||
          !validSelection(context, parsed['bound'], parsed['editable'])) return null;
      const bound = parsed['bound'], editable = new Set(parsed['editable'] as string[]);
      if (Object.keys(inputs).some(name => Object.hasOwn(bound, name) || !editable.has(name))) return null;
      return Object.assign(Object.create(null) as ClosedInputs, inputs, bound);
    },
  };
}
