/**
 * Lane 04 services contracts: capability surfaces, provider bindings,
 * adapter features/limits, verified ingress and completion envelopes.
 *
 * Normative basis: DESIGN section 8 (first-class services), section 8.1
 * (associated typed deliveries); DECISIONS payment, billing-evidence and
 * delivery entries (Oct 4, 2026).
 *
 * Type-only boundary. Adapter transport, credential handling, pagination
 * execution and result mapping live in `@canlang/services`. Exact value
 * wire encodings (money, datetime, decimal) belong to lane 2: fields typed
 * `unknown` below name their lane-2 type in documentation and must survive
 * JSON transport with exact-value tags (CONTRACTS.md).
 */

import type { FinalizedFileRef } from './files.js';

/** Closed delivery receipt summary (DESIGN section 8). */
export interface DeliveryResult {
  id: string;
  status: DeliveryStatus;
}

/** Delivery status; `skipped` is undispatched/superseded/ineligible work. */
export type DeliveryStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'skipped';

/**
 * Single closed error payload. Stable safe machine classification plus a
 * safe explanation; never credentials, tokens, bodies, traces or account
 * data. No `details`, `retryable` or provider-response fields.
 */
export interface DeliveryError {
  code: string;
  message: string;
}

/**
 * Typed adapter completion for `Target.completed` (DESIGN section 8).
 * Validate status and payload together: succeeded carries the declared
 * result with null error; failed carries null result with non-null error;
 * unknown carries null result with a safe diagnostic error or null;
 * skipped carries null result and null error. Pending is a receipt, never
 * a completion occurrence.
 */
export interface CapabilityCompletion<R> {
  delivery_id: string;
  status: Exclude<DeliveryStatus, 'pending'>;
  result: R | null;
  error: DeliveryError | null;
}

/**
 * One typed capability operation: typed inputs in, eventual provider result
 * out. `-> R` names the provider result, not the enqueue receipt (DESIGN
 * section 8). Type names resolve through lanes 1/2; this contract carries
 * references, not the schema language.
 */
export interface CapabilityOperation {
  name: string;
  /** Parameter name to declared type name. */
  inputs: Record<string, string>;
  /** Declared provider-result type name. */
  result: string;
}

/**
 * Verified inbound event declared inside a capability
 * (`event changed {fields}` in DESIGN section 8).
 */
export interface CapabilityEventDecl {
  name: string;
  /** Field name to declared type name. */
  fields: Record<string, string>;
}

/**
 * Provider-owned capability contract. The provider owns these declarations;
 * consumers bind them with `use provider {…} from=deployment.…` (DESIGN
 * section 8). No runtime discovery or version negotiation.
 */
export interface CapabilityContract {
  name: string;
  version: number;
  operations: CapabilityOperation[];
  events: CapabilityEventDecl[];
}

/**
 * Installed binding of an adapter to a versioned capability implementation.
 * Fixes authentication, team/resource namespace and wire mapping. Secrets
 * are server-only and never appear in this shape.
 */
export interface ProviderBinding {
  /** Capability name, e.g. `std.EmailV1`. */
  capability: string;
  capabilityVersion: number;
  /** Deployment binding identity, e.g. `deployment.mail`. */
  deployment: string;
  /** Provider account identity for event normalization checks. */
  account: string;
}

/**
 * Adapter-supported operations, events and transport features. The compiler
 * checks the small declared contract; vendor API breadth stays here.
 */
export interface AdapterFeatures {
  operations: string[];
  events: string[];
  /** Bounded pagination supported with explicit page shapes below. */
  pagination: boolean;
  /** Unknown-outcome reconciliation supported via original identity. */
  reconciliation: boolean;
}

/** Declared deployment quotas; overload records failure, never success. */
export interface ProviderLimits {
  /** Maximum accepted page size, when pagination applies. */
  maxPageSize: number | null;
  /** Aggregate transport limit in bytes, e.g. mail attachments. */
  maxTransportBytes: number | null;
}

/** Bounded page request over a provider listing. */
export interface PageRequest {
  cursor: string | null;
  limit: number;
}

/** Bounded page of typed provider items. */
export interface ProviderPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Verified causation envelope carried by a trusted ingress event (DESIGN
 * section 8). The binding authenticates the producer and fixes the allowed
 * namespace; authority resolves from declared request references.
 */
export interface VerifiedIngressEnvelope {
  /** Configured source/site namespace. */
  namespace: string;
  /** Stable producer event id preserved through queued work. */
  producerEventId: string;
  /** Canonical operation kind, e.g. `charge`, `cancel`, `refund`. */
  operationKind: string;
  /** Immutable request digest of the originating delivery. */
  requestDigest: string;
  /** Originating delivery id when completing a prior send. */
  deliveryId: string | null;
}

/** `std.EmailV1` send inputs (DESIGN section 8). */
export interface EmailSendInput {
  to: string;
  subject: string;
  /** Escaped plain text; sender identity is deployment configuration. */
  body: string;
  attachments: FinalizedFileRef[];
}

/** `std.EmailV1` acceptance: a provider receipt, not proof of reading. */
export interface EmailAccepted {
  reference: string;
}

/** Shared structural workflow result (DESIGN section 8). */
export interface OperationOutcome {
  source: string;
  revision: number;
  state:
    | 'pending'
    | 'confirmed'
    | 'unavailable'
    | 'failed'
    | 'unknown'
    | 'released';
  reference?: string;
  detail?: string;
}

/**
 * `std.PaymentsV1` payment state (DESIGN section 8). `amount` is the lane-2
 * money wire shape. Revisions are monotone per attempt; same revision has
 * identical business content. `failure` is present only for a definite
 * failed outcome.
 */
export interface PaymentState {
  reference: string;
  revision: number;
  provider_reference: string | null;
  /** Lane-2 money wire shape. */
  amount: unknown;
  status: 'pending' | 'unknown' | 'succeeded' | 'failed';
  checkout_url: string | null;
  failure: 'transient' | 'action_required' | 'permanent' | 'cancelled' | null;
}

/** `std.PaymentsV1` collect inputs. Consent text is not proof of mandate. */
export interface PaymentCollectInput {
  customer: string;
  /** Lane-2 money wire shape; must be positive. */
  amount: unknown;
  reference: string;
  consent: string | null;
}

/** `std.PaymentsV1` refund inputs; a refund has its own logical reference. */
export interface PaymentRefundInput {
  payment: string;
  /** Lane-2 money wire shape; must be positive. */
  amount: unknown;
  reference: string;
}

/**
 * `std.PaymentsV1` cancel inputs. Disables new use of the attempt's
 * checkout; never a refund and never proof that uncertain money is gone.
 */
export interface PaymentCancelInput {
  reference: string;
}

/** `std.PaymentsV1` reconcile inputs; reuses the original identity. */
export interface PaymentReconcileInput {
  reference: string;
}

/** `std.ErrorsV1` report (DESIGN section 8). */
export interface ErrorReport {
  id: string;
  message: string;
  /** Lane-2 datetime wire shape. */
  occurred_at: unknown;
  stack: string | null;
  release: string | null;
  environment: string | null;
}

/** `std.ErrorsV1` acceptance. */
export interface ErrorAccepted {
  reference: string;
}
