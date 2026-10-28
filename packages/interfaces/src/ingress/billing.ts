/**
 * FP.SOURCE-MAPPINGS: the first configured versioned ingress binding —
 * BillingIngress over standard webhooks v1.
 *
 * Binding: namespace + team/owner + pinned adapter
 * (`standard-webhooks-v1-billing`), configured from explicit
 * `CAN_INGRESS_BILLING_*` deployment values. No adapter discovery or
 * version guessing: the loader pins the adapter name and the verifier
 * pins event `version: 1`.
 *
 * Verification mirrors the identity-removal profile's standard-webhooks
 * mechanics (shared helpers): `webhook-id`/`webhook-timestamp`/
 * `webhook-signature` headers, `{id}.{timestamp}.{body}` HMAC-SHA-256
 * against current/previous `whsec_` keys, closed strict event grammar,
 * producer/namespace/binding agreement, and five-minute/known-future
 * age windows with re-admission after every await. Failures return
 * null (fail closed, no oracle detail); billing events are
 * self-contained, so there is no original-occurrence reader —
 * duplicates are the sink's idempotency on `producer_event_id`.
 *
 * Correlation: the sink commits one outcome record per accepted
 * envelope, keyed by `producer_event_id`, through the injected
 * `BillingOutcomeStore`. Only matching committed outcomes associate:
 * lookups by any other id find nothing, and replays return the
 * original record bytes. Durable backends implement the port; the
 * memory store serves development and tests.
 */
import type { VerifiedIngressEnvelope } from '@canlang/contracts';
import type { DelegatedContext, IngressBinding, IngressVerifier, InterfacesClock } from '../ports.js';
import { INGRESS_BODY_MAX_BYTES } from './routes.js';
import {
  checkIngressHeaders,
  configuredKeys,
  parseIngressSignatures,
  verifyIngressSignatures,
} from './identity-removal.js';

/** Pinned versioned adapter profile for billing ingress. */
export const BILLING_ADAPTER = 'standard-webhooks-v1-billing';

/** Pinned billing event contract version. */
export const BILLING_EVENT_VERSION = 1;

const BINDING_FIELDS = ['namespace', 'adapter', 'team', 'owner'] as const;
const EVENT_FIELDS = [
  'version',
  'type',
  'producer_event_id',
  'occurred_at',
  'invoice',
  'amount',
  'currency',
] as const;

function ownValue(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, name);
  return property !== undefined && 'value' in property && property.enumerable ? property.value : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Parse only the billing grammar: a closed flat object with string
 * leaves plus numeric `version`. Duplicate members (including escaped
 * aliases) reject before `JSON.parse` can discard them.
 */
function parseBillingBody(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    let at = 0;
    const space = (): void => {
      while (/[\x20\t\r\n]/.test(text[at] ?? '') && at < text.length) at++;
    };
    const expect = (token: string): void => {
      space();
      if (!text.startsWith(token, at)) throw new SyntaxError('Invalid billing JSON.');
      at += token.length;
    };
    const string = (): string => {
      space();
      const start = at;
      if (text[at++] !== '"') throw new SyntaxError('Invalid billing JSON.');
      while (at < text.length) {
        const character = text[at++];
        if (character === '\\') at++;
        else if (character === '"') return JSON.parse(text.slice(start, at)) as string;
      }
      throw new SyntaxError('Invalid billing JSON.');
    };
    const number = (): number => {
      space();
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
      if (match === null) throw new SyntaxError('Invalid billing JSON.');
      at += match[0].length;
      return Number(match[0]);
    };
    expect('{');
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    space();
    if (text[at] === '}') return null;
    for (;;) {
      const name = string();
      if (Object.hasOwn(result, name)) throw new SyntaxError('Duplicate billing JSON member.');
      expect(':');
      space();
      result[name] = text[at] === '"' ? string() : number();
      space();
      if (text[at] === '}') {
        at++;
        break;
      }
      expect(',');
    }
    space();
    if (at !== text.length) return null;
    if (Reflect.ownKeys(result).length !== EVENT_FIELDS.length) return null;
    if (!EVENT_FIELDS.every(name => ownValue(result, name) !== undefined)) return null;
    return result;
  } catch {
    return null;
  }
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

export function createBillingIngressVerifier(options: {
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
    ) && scope[1] === BILLING_ADAPTER && isCurrent() === true;
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
        const event = parseBillingBody(body);
        const attempt = Number(timestamp) * 1000;
        if (
          event === null ||
          event['version'] !== BILLING_EVENT_VERSION ||
          event['type'] !== 'invoice.paid' ||
          event['producer_event_id'] !== id ||
          !['occurred_at', 'invoice', 'amount', 'currency'].every(name => nonempty(event[name])) ||
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
          operationKind: 'charge',
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

/** One committed billing outcome, correlated by producer event id. */
export interface BillingOutcomeRecord {
  readonly producerEventId: string;
  readonly namespace: string;
  readonly operationKind: string;
  readonly requestDigest: string;
  readonly event: Readonly<Record<string, unknown>>;
  readonly committedAt: string;
}

/** Durable port: committed billing outcomes keyed by producer event id. */
export interface BillingOutcomeStore {
  /** Put-if-absent; replays return the original record unchanged. */
  record(outcome: BillingOutcomeRecord): Promise<BillingOutcomeRecord>;
  findByProducerEventId(producerEventId: string): Promise<BillingOutcomeRecord | null>;
}

export function createMemoryBillingOutcomeStore(): BillingOutcomeStore {
  const records = new Map<string, BillingOutcomeRecord>();
  return {
    async record(outcome: BillingOutcomeRecord): Promise<BillingOutcomeRecord> {
      const existing = records.get(outcome.producerEventId);
      if (existing !== undefined) return existing;
      records.set(outcome.producerEventId, outcome);
      return outcome;
    },
    async findByProducerEventId(producerEventId: string): Promise<BillingOutcomeRecord | null> {
      return records.get(producerEventId) ?? null;
    },
  };
}

export function createBillingIngressSink(options: {
  readonly store: BillingOutcomeStore;
  readonly clock: InterfacesClock;
}): { accept(context: DelegatedContext, event: unknown): Promise<{ accepted: boolean }> } {
  const { store, clock } = options;
  return {
    async accept(context: DelegatedContext, event: unknown): Promise<{ accepted: boolean }> {
      const causation = context.causation as Partial<VerifiedIngressEnvelope> | null;
      const producerEventId =
        typeof causation === 'object' && causation !== null ? causation.producerEventId : undefined;
      if (
        typeof producerEventId !== 'string' ||
        producerEventId === '' ||
        typeof event !== 'object' ||
        event === null ||
        Array.isArray(event)
      ) {
        return { accepted: false };
      }
      await store.record({
        producerEventId,
        namespace: context.namespace,
        operationKind:
          typeof causation?.operationKind === 'string' ? causation.operationKind : 'charge',
        requestDigest: typeof causation?.requestDigest === 'string' ? causation.requestDigest : '',
        event: { ...(event as Record<string, unknown>) },
        committedAt: new Date(clock.nowMs()).toISOString(),
      });
      return { accepted: true };
    },
  };
}

/**
 * Load the configured billing binding from explicit deployment values.
 * The adapter is pinned (never negotiated); keys stay server-only and
 * are validated structurally here so misconfiguration fails fast at
 * boot, not on first delivery.
 */
export function loadBillingIngressBinding(env: Record<string, string | undefined>): {
  readonly binding: IngressBinding;
  readonly keys: () => { readonly current: string; readonly previous?: string } | null;
} {
  const namespace = env['CAN_INGRESS_BILLING_NAMESPACE'];
  const team = env['CAN_INGRESS_BILLING_TEAM'];
  const owner = env['CAN_INGRESS_BILLING_OWNER'];
  const keysJson = env['CAN_INGRESS_BILLING_KEYS'];
  if (
    namespace === undefined ||
    namespace === '' ||
    team === undefined ||
    team === '' ||
    owner === undefined ||
    owner === ''
  ) {
    throw new Error(
      'billing-ingress: CAN_INGRESS_BILLING_NAMESPACE/TEAM/OWNER require explicit non-empty configuration',
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
      'billing-ingress: CAN_INGRESS_BILLING_KEYS requires {current, previous?} whsec_ publication',
    );
  }
  const binding: IngressBinding = { namespace, adapter: BILLING_ADAPTER, team, owner };
  return {
    binding,
    keys: () => keys as { readonly current: string; readonly previous?: string },
  };
}
