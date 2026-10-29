/**
 * FP.SOURCE-MAPPINGS: the second configured versioned ingress binding —
 * SalesIngress over standard webhooks v1.
 *
 * Binding: namespace + team/owner + pinned adapter
 * (`standard-webhooks-v1-sales`), configured from explicit
 * `CAN_INGRESS_SALES_*` deployment values. No adapter discovery or
 * version guessing: the loader pins the adapter name and the verifier
 * pins event `version: 1`.
 *
 * Verification mirrors the identity-removal profile's standard-webhooks
 * mechanics (shared helpers): `webhook-id`/`webhook-timestamp`/
 * `webhook-signature` headers, `{id}.{timestamp}.{body}` HMAC-SHA-256
 * against current/previous `whsec_` keys, closed strict event grammar,
 * producer/namespace/binding agreement, and five-minute/known-future
 * age windows with re-admission after every await. Failures return
 * null (fail closed, no oracle detail); sales events are
 * self-contained, so there is no original-occurrence reader —
 * duplicates are the sink's idempotency on `producer_event_id`.
 *
 * Correlation: accepted envelopes commit through the shared
 * ingress outcome sink (`./outcomes.js`), keyed by
 * `producer_event_id`.
 */
import type { VerifiedIngressEnvelope } from '@canlang/contracts';
import type { IngressBinding, IngressVerifier, InterfacesClock } from '../ports.js';
import { INGRESS_BODY_MAX_BYTES } from './routes.js';
import {
  checkIngressHeaders,
  configuredKeys,
  parseClosedIngressBody,
  parseIngressSignatures,
  verifyIngressSignatures,
} from './identity-removal.js';

/** Pinned versioned adapter profile for sales ingress. */
export const SALES_ADAPTER = 'standard-webhooks-v1-sales';

/** Pinned sales event contract version. */
export const SALES_EVENT_VERSION = 1;

const BINDING_FIELDS = ['namespace', 'adapter', 'team', 'owner'] as const;
const EVENT_FIELDS = [
  'version',
  'type',
  'producer_event_id',
  'occurred_at',
  'lead',
  'email',
  'source',
] as const;

function ownValue(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, name);
  return property !== undefined && 'value' in property && property.enumerable ? property.value : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Parse only the sales grammar: the shared closed flat-object parser over the pinned sales fields. */
function parseSalesBody(bytes: Uint8Array): Record<string, unknown> | null {
  return parseClosedIngressBody(bytes, EVENT_FIELDS);
}

function inAge(now: number, attempt: number, occurredAt: string): boolean {
  const original = Date.parse(occurredAt);
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    Number.isSafeInteger(attempt) &&
    Number.isFinite(original) &&
    new Date(original).toISOString() === occurredAt &&
    now - attempt <= 300_000 &&
    attempt - now <= 30_000 &&
    now - original <= 86_400_000 &&
    original - now <= 30_000
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createSalesIngressVerifier(options: {
  readonly binding: IngressBinding;
  readonly clock: InterfacesClock;
  readonly keys: () => { readonly current: string; readonly previous?: string } | null;
  readonly isCurrent: () => boolean;
}): IngressVerifier {
  const { binding, clock, keys, isCurrent } = options;
  const scope = BINDING_FIELDS.map(name => ownValue(binding, name));
  const current = (): boolean =>
    scope.every(
      (value, index) => nonempty(value) && ownValue(binding, BINDING_FIELDS[index]!) === value,
    ) && scope[1] === SALES_ADAPTER && isCurrent() === true;
  return {
    async verify(requestBinding, input) {
      try {
        if (
          requestBinding !== binding ||
          !current() ||
          !(input.body instanceof Uint8Array) ||
          input.body.byteLength > INGRESS_BODY_MAX_BYTES
        ) {
          return null;
        }
        const body = new Uint8Array(input.body);
        const headers = checkIngressHeaders(input);
        if (headers === null) return null;
        const { id, timestamp, signature } = headers;
        const signatures = parseIngressSignatures(signature);
        if (signatures === null) return null;
        const event = parseSalesBody(body);
        const attempt = Number(timestamp) * 1000;
        if (
          event === null ||
          event['version'] !== SALES_EVENT_VERSION ||
          event['type'] !== 'lead.created' ||
          event['producer_event_id'] !== id ||
          !['occurred_at', 'lead', 'email', 'source'].every(name => nonempty(event[name])) ||
          !inAge(clock.nowMs(), attempt, event['occurred_at'] as string)
        ) {
          return null;
        }
        const initialKeys = configuredKeys(keys());
        if (initialKeys === null) return null;
        const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
        const signed = new Uint8Array(prefix.length + body.length);
        signed.set(prefix);
        signed.set(body, prefix.length);
        const acceptedKeys = await verifyIngressSignatures(initialKeys, signatures, signed);
        const admitted = (): boolean => {
          const active = configuredKeys(keys());
          return (
            current() &&
            active !== null &&
            [...acceptedKeys].some(key => active.has(key)) &&
            inAge(clock.nowMs(), attempt, event['occurred_at'] as string)
          );
        };
        if (!admitted()) return null;
        const requestDigest = hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', body)));
        if (!admitted()) return null;
        const envelope: VerifiedIngressEnvelope = {
          namespace: scope[0] as string,
          producerEventId: id,
          operationKind: 'lead',
          requestDigest,
          deliveryId: null,
        };
        return admitted() ? envelope : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Load the configured sales binding from explicit deployment values.
 * The adapter is pinned (never negotiated); keys stay server-only and
 * are validated structurally here so misconfiguration fails fast at
 * boot, not on first delivery.
 */
export function loadSalesIngressBinding(env: Record<string, string | undefined>): {
  readonly binding: IngressBinding;
  readonly keys: () => { readonly current: string; readonly previous?: string } | null;
} {
  const namespace = env['CAN_INGRESS_SALES_NAMESPACE'];
  const team = env['CAN_INGRESS_SALES_TEAM'];
  const owner = env['CAN_INGRESS_SALES_OWNER'];
  const keysJson = env['CAN_INGRESS_SALES_KEYS'];
  if (
    namespace === undefined ||
    namespace === '' ||
    team === undefined ||
    team === '' ||
    owner === undefined ||
    owner === ''
  ) {
    throw new Error(
      'sales-ingress: CAN_INGRESS_SALES_NAMESPACE/TEAM/OWNER require explicit non-empty configuration',
    );
  }
  let keys: unknown;
  try {
    keys = keysJson === undefined ? undefined : (JSON.parse(keysJson) as unknown);
  } catch {
    keys = undefined;
  }
  if (configuredKeys(keys) === null) {
    throw new Error(
      'sales-ingress: CAN_INGRESS_SALES_KEYS requires {current, previous?} whsec_ publication',
    );
  }
  const binding: IngressBinding = { namespace, adapter: SALES_ADAPTER, team, owner };
  return {
    binding,
    keys: () => keys as { readonly current: string; readonly previous?: string },
  };
}
