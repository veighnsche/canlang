/**
 * FP.SOURCE-MAPPINGS: committed-outcome correlation shared by the
 * configured versioned ingress bindings.
 *
 * The sink commits one outcome record per accepted envelope, keyed
 * by `producer_event_id`, through the injected `IngressOutcomeStore`.
 * Only matching committed outcomes associate: lookups by any other
 * id find nothing, and replays return the original record bytes.
 * Durable backends implement the port; the memory store serves
 * development and tests.
 */
import type { VerifiedIngressEnvelope } from '@canlang/contracts';
import type { DelegatedContext, InterfacesClock } from '../ports.js';

/** One committed ingress outcome, correlated by producer event id. */
export interface IngressOutcomeRecord {
  readonly producerEventId: string;
  readonly namespace: string;
  readonly operationKind: string;
  readonly requestDigest: string;
  readonly event: Readonly<Record<string, unknown>>;
  readonly committedAt: string;
}

/** Durable port: committed ingress outcomes keyed by producer event id. */
export interface IngressOutcomeStore {
  /** Put-if-absent; replays return the original record unchanged. */
  record(outcome: IngressOutcomeRecord): Promise<IngressOutcomeRecord>;
  findByProducerEventId(producerEventId: string): Promise<IngressOutcomeRecord | null>;
}

export function createMemoryIngressOutcomeStore(): IngressOutcomeStore {
  const records = new Map<string, IngressOutcomeRecord>();
  return {
    async record(outcome: IngressOutcomeRecord): Promise<IngressOutcomeRecord> {
      const existing = records.get(outcome.producerEventId);
      if (existing !== undefined) return existing;
      records.set(outcome.producerEventId, outcome);
      return outcome;
    },
    async findByProducerEventId(producerEventId: string): Promise<IngressOutcomeRecord | null> {
      return records.get(producerEventId) ?? null;
    },
  };
}

export function createIngressOutcomeSink(options: {
  readonly store: IngressOutcomeStore;
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
