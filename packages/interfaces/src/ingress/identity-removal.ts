/** The bounded operator-controlled Identity removal profile; no source issuer. */
import type { VerifiedTeamsMemberRemovedEnvelope } from '@canlang/contracts';
import type { IdentityStore } from '@canlang/identity';
import type { IngressBinding, IngressVerifier, InterfacesClock } from '../ports.js';
import { INGRESS_BODY_MAX_BYTES } from './routes.js';

const ADAPTER = 'standard-webhooks-v1-identity-removal';
const ENVELOPE_FIELDS = ['namespace', 'producerEventId', 'requestDigest', 'operationKind',
  'deliveryId', 'membershipRemoval', 'removedBy', 'operationId', 'occurredAt'] as const;
const BINDING_FIELDS = ['namespace', 'adapter', 'team', 'owner'] as const;
type JsonObject = { [name: string]: JsonObject | string | null };

function ownValue(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, name);
  return property !== undefined && 'value' in property && property.enumerable ? property.value : undefined;
}

function closed(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === names.length &&
    names.every(name => ownValue(value, name) !== undefined);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Parse only this profile's string/null/object grammar. Track decoded names,
 * including escaped aliases, before JSON.parse can discard duplicate members. */
function parseBody(bytes: Uint8Array): JsonObject | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    let at = 0;
    const space = (): void => { while (/[\x20\t\r\n]/.test(text[at] ?? '') && at < text.length) at++; };
    const expect = (token: string): void => {
      space();
      if (!text.startsWith(token, at)) throw new SyntaxError('Invalid ingress JSON.');
      at += token.length;
    };
    const string = (): string => {
      space();
      const start = at;
      if (text[at++] !== '"') throw new SyntaxError('Invalid ingress JSON.');
      while (at < text.length) {
        const character = text[at++];
        if (character === '\\') at++;
        else if (character === '"') return JSON.parse(text.slice(start, at)) as string;
      }
      throw new SyntaxError('Invalid ingress JSON.');
    };
    const object = (depth: number): JsonObject => {
      if (depth > 3) throw new SyntaxError('Invalid ingress JSON.');
      expect('{');
      const result: JsonObject = Object.create(null) as JsonObject;
      space();
      if (text[at] === '}') { at++; return result; }
      for (;;) {
        const name = string();
        if (Object.hasOwn(result, name)) throw new SyntaxError('Duplicate ingress JSON member.');
        expect(':');
        space();
        if (text[at] === '"') result[name] = string();
        else if (text[at] === '{') result[name] = object(depth + 1);
        else { expect('null'); result[name] = null; }
        space();
        if (text[at] === '}') { at++; return result; }
        expect(',');
      }
    };
    const result = object(1);
    space();
    return at === text.length ? result : null;
  } catch { return null; }
}

function envelope(value: unknown): value is VerifiedTeamsMemberRemovedEnvelope {
  if (!closed(value, ENVELOPE_FIELDS) || value['operationKind'] !== 'teams.member_removed' ||
      value['deliveryId'] !== null ||
      !['namespace', 'producerEventId', 'requestDigest', 'operationId', 'occurredAt'].every(name => nonempty(value[name])) ||
      !/^[a-f0-9]{64}$/.test(value['requestDigest'] as string)) return false;
  const removal = value['membershipRemoval'], remover = value['removedBy'];
  if (!closed(removal, ['team_id', 'membership_id', 'user']) || !nonempty(removal['team_id']) ||
      !nonempty(removal['membership_id']) || !closed(remover, ['kind', 'id']) ||
      remover['kind'] !== 'user' || !nonempty(remover['id'])) return false;
  const user = removal['user'];
  return closed(user, ['kind', 'id']) && user['kind'] === 'user' && nonempty(user['id']);
}

/** Fixed 32-byte canonical padded Base64, including unused tail bits. */
function base64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const binary = atob(value);
  if (binary.length !== 32 || btoa(binary) !== value) return null;
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function configuredKeys(value: unknown): Map<string, Uint8Array> | null {
  if (!closed(value, Object.hasOwn(value ?? {}, 'previous') ? ['current', 'previous'] : ['current'])) return null;
  const result = new Map<string, Uint8Array>();
  for (const name of Object.keys(value)) {
    const key = value[name];
    const bytes = typeof key === 'string' && key.startsWith('whsec_') ? base64(key.slice(6)) : null;
    if (bytes === null) return null;
    result.set(key as string, bytes);
  }
  return result;
}

function sameOriginal(body: VerifiedTeamsMemberRemovedEnvelope, original: VerifiedTeamsMemberRemovedEnvelope): boolean {
  return ENVELOPE_FIELDS.filter(name => name !== 'membershipRemoval' && name !== 'removedBy')
    .every(name => body[name] === original[name]) &&
    body.membershipRemoval.team_id === original.membershipRemoval.team_id &&
    body.membershipRemoval.membership_id === original.membershipRemoval.membership_id &&
    body.membershipRemoval.user.kind === original.membershipRemoval.user.kind &&
    body.membershipRemoval.user.id === original.membershipRemoval.user.id &&
    body.removedBy.kind === original.removedBy.kind && body.removedBy.id === original.removedBy.id;
}

function inAge(now: number, attempt: number, occurredAt: string): boolean {
  const original = Date.parse(occurredAt);
  return Number.isSafeInteger(now) && now >= 0 && Number.isSafeInteger(attempt) &&
    Number.isFinite(original) && new Date(original).toISOString() === occurredAt &&
    now - attempt <= 300_000 && attempt - now <= 30_000 &&
    now - original <= 86_400_000 && original - now <= 30_000;
}

/**
 * Bind one existing ingress namespace to its original trusted host callbacks.
 * The host owns key publication/retirement, physical source/receiver lifetime,
 * and the SELECT-only reader's original receiver. No callback issues a cause.
 * captureVerified privately associates this exact genuine envelope with its raw
 * SHA-256 digest for the paired sink; it is not an event or authority carrier.
 */
export function createIdentityRemovalIngressVerifier(options: {
  readonly binding: IngressBinding;
  readonly clock: InterfacesClock;
  readonly keys: () => { readonly current: string; readonly previous?: string } | null;
  readonly isCurrent: () => boolean;
  readonly readOriginalOccurrence: NonNullable<IdentityStore['readMemberRemovalOccurrence']>;
  readonly captureVerified: (original: VerifiedTeamsMemberRemovedEnvelope, rawBodyDigest: string) => void;
}): IngressVerifier {
  const { binding, clock, keys, isCurrent, readOriginalOccurrence, captureVerified } = options;
  const scope = BINDING_FIELDS.map(name => ownValue(binding, name));
  const current = (): boolean => scope.every((value, index) => nonempty(value) &&
    ownValue(binding, BINDING_FIELDS[index]!) === value) &&
    scope[1] === ADAPTER && isCurrent() === true;
function settleVerifiedCapture(
  captureVerified: (original: VerifiedTeamsMemberRemovedEnvelope, rawBodyDigest: string) => void,
  admitted: () => boolean,
  original: VerifiedTeamsMemberRemovedEnvelope,
  rawDigest: Uint8Array,
): VerifiedTeamsMemberRemovedEnvelope | null {
  const digest = Array.from(rawDigest, byte => byte.toString(16).padStart(2, '0')).join('');
  const capture: unknown = captureVerified(original, digest);
  if (capture !== null && (typeof capture === 'object' || typeof capture === 'function') &&
      typeof (capture as { then?: unknown }).then === 'function') {
    // A void callback can still return a Promise in TypeScript. Reject
    // asynchronous capture and consume its failure without admitting it.
    void Promise.resolve(capture).catch(() => undefined);
    return null;
  }
  return admitted() ? original : null;
}

function checkIngressHeaders(input: { headers: unknown }): { id: string; timestamp: string; signature: string } | null {
  const id = ownValue(input.headers, 'webhook-id');
  const timestamp = ownValue(input.headers, 'webhook-timestamp');
  const signature = ownValue(input.headers, 'webhook-signature');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id) ||
      typeof timestamp !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(timestamp) ||
      !Number.isSafeInteger(Number(timestamp)) || typeof signature !== 'string' ||
      signature.length > 4096) return null;
  return { id, timestamp, signature };
}

function parseIngressSignatures(signature: string): Uint8Array[] | null {
  const entries = signature.split(' ');
  if (entries.length < 1 || entries.length > 8) return null;
  const signatures: Uint8Array[] = [];
  for (const entry of entries) {
    const bytes = entry.startsWith('v1,') ? base64(entry.slice(3)) : null;
    if (bytes === null) return null;
    signatures.push(bytes);
  }
  return signatures;
}

async function verifyIngressSignatures(
  initialKeys: Map<string, Uint8Array>,
  signatures: Uint8Array[],
  signed: Uint8Array,
): Promise<Set<string>> {
  const acceptedKeys = new Set<string>();
  for (const [encoded, bytes] of initialKeys) {
    const key = await globalThis.crypto.subtle.importKey('raw', bytes.slice(),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    for (const mac of signatures) {
      // Host HMAC verification owns the timing-safe comparison.
      if (await globalThis.crypto.subtle.verify('HMAC', key, Uint8Array.from(mac), Uint8Array.from(signed))) acceptedKeys.add(encoded);
    }
  }
  return acceptedKeys;
}

  return {
    async verify(requestBinding, input) {
      try {
        if (requestBinding !== binding || !current() || !(input.body instanceof Uint8Array) ||
            input.body.byteLength > INGRESS_BODY_MAX_BYTES) return null;
        // Detach all signed input before the first await; never reserialize it.
        const body = new Uint8Array(input.body);
        const headers = checkIngressHeaders(input);
        if (headers === null) return null;
        const { id, timestamp, signature } = headers;
        const signatures = parseIngressSignatures(signature);
        if (signatures === null) return null;
        const event = parseBody(body), attempt = Number(timestamp) * 1000;
        if (!envelope(event) || event.producerEventId !== id || event.namespace !== scope[0] ||
            event.membershipRemoval.team_id !== scope[2] || !inAge(clock.nowMs(), attempt, event.occurredAt)) return null;
        const initialKeys = configuredKeys(keys());
        if (initialKeys === null) return null;
        const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
        const signed = new Uint8Array(prefix.length + body.length);
        signed.set(prefix); signed.set(body, prefix.length);
        const acceptedKeys = await verifyIngressSignatures(initialKeys, signatures, signed);
        const admitted = (): boolean => {
          const active = configuredKeys(keys());
          return current() && active !== null && [...acceptedKeys].some(key => active.has(key)) &&
            inAge(clock.nowMs(), attempt, event.occurredAt);
        };
        if (!admitted()) return null;
        const rawDigest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', body));
        if (!admitted()) return null;
        const original = await readOriginalOccurrence({ team_id: scope[2] as string,
          member_user_id: event.membershipRemoval.user.id, removed_by: event.removedBy.id,
          namespace: scope[0] as string, operationId: event.operationId });
        if (!envelope(original) || !sameOriginal(event, original) || !admitted()) return null;
        return settleVerifiedCapture(captureVerified, admitted, original, rawDigest);
      } catch { return null; }
    },
  };
}
