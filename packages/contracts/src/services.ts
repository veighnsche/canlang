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

/**
 * Provider-owned `ai.ChatV1` message (research sketch "final chat";
 * `design/research-ai-capabilities-20261004.md`). Minimal final-only
 * shape: no tools/images/thinking until an app uses them.
 */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/** Provider-owned `ai.ChatV1` generate inputs. */
export interface ModelChatInput {
  /** Bound model id; validated against the deployment allowlist. */
  model: string;
  /** Frozen authorized history; the adapter sends this, never a hidden provider conversation. */
  messages: ModelMessage[];
  /** Generation output budget; provider options stay adapter-owned. */
  maxTokens: number;
}

/**
 * Provider-owned `ai.ChatV1` final reply. Usage is nullable because
 * providers may omit it; absence never fails an otherwise complete reply.
 */
export interface ModelChatReply {
  content: string;
  model: string;
  /** Provider done/finish reason. */
  finish: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Provider-owned `ai.ChatV1` run observation state. */
export type ModelRunState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled';

/**
 * Provider-owned `ai.ChatV1` run snapshot. `sequence` orders snapshots
 * within one run; correlation (source/revision/delivery) travels with
 * the frozen request and the delivery association, never inside model
 * content. Snapshots are bounded presentation state, not lossless
 * token replay.
 */
export interface ModelRunSnapshot {
  sequence: number;
  state: ModelRunState;
  /** Cumulative user-visible content; provider thinking stays separate. */
  content: string;
}

/**
 * Provider-owned `ai.SystemOneV1` judgment question. Wire shape follows
 * the System One API (`tools/jev.py` plus documented answer shapes):
 * questions ride as `{id: {type, instructions, criteria}}` with choice
 * criteria as an option map and score criteria as an ordered level
 * list. Thresholds and routing stay authored business policy; the
 * adapter preserves distributions and never thresholds.
 */
export type JudgmentQuestion =
  | { kind: 'noul'; id: string; instructions: string }
  | {
      kind: 'choice';
      id: string;
      instructions: string;
      /** Option id to description; 1..provider-max entries. */
      options: Record<string, string>;
    }
  | {
      kind: 'score';
      id: string;
      instructions: string;
      /** Ordered level descriptions, lowest first. */
      levels: string[];
    };

/** Provider-owned `ai.SystemOneV1` batch inputs. */
export interface JudgmentBatchInput {
  /** Bound model id/alias; validated against the deployment allowlist. */
  model: string;
  /** App-typed minimized state, serialized once; must be JSON-serializable. */
  state: Record<string, unknown>;
  /** Non-empty; ids must be unique. */
  questions: JudgmentQuestion[];
}

/** Noul answer: probability of yes. No confidence field exists. */
export interface NoulAnswer {
  probability: number;
}

/** Choice answer: selected label, full distribution, confidence. */
export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

/** One ordered score level with its legend description and probability. */
export interface ScoreLevel {
  index: number;
  description: string;
  probability: number;
}

/** Score answer: probability-weighted index, ordered levels, confidence. */
export interface ScoreAnswer {
  score: number;
  levels: ScoreLevel[];
  confidence: number;
}

/** One normalized typed answer, keyed by the requested question id. */
export type JudgmentAnswer =
  | { kind: 'noul'; id: string; answer: NoulAnswer }
  | { kind: 'choice'; id: string; answer: ChoiceAnswer }
  | { kind: 'score'; id: string; answer: ScoreAnswer };

/** Provider-owned `ai.SystemOneV1` batch result, in request order. */
export interface JudgmentBatchResult {
  /** Actual answering model (aliases resolve server-side). */
  model: string;
  /** One answer per requested question, in request order. */
  answers: JudgmentAnswer[];
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Provider-owned `ai.ImagesV1` business inputs. These are mapped onto
 * graph node inputs by the binding's workflow map; the adapter
 * substitutes only declared scalar slots and validates the graph
 * digest, never inventing nodes or resizing silently.
 */
export interface ImageGenerateInput {
  prompt: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
}

/**
 * Submission acceptance: a provider job reference. The business image
 * run remains queued; acceptance never proves an image exists.
 */
export interface ImageAccepted {
  job: string;
}

/**
 * One downloaded output image. `position` is the stable index within
 * the node's image list; `node` + `position` jointly identify the
 * output. `contentType` is the transport claim; actual bytes win at
 * files validation (S8 join).
 */
export interface GeneratedImage {
  node: string;
  position: number;
  contentType: string;
  sizeBytes: number;
  bytes: Uint8Array;
}

/** Provider-owned `ai.ImagesV1` run state. */
export type ImageRunState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled';

/**
 * Provider-owned `ai.ImagesV1` observed run. Delivery success stays
 * distinct from image-run success: a failed run is data (state +
 * partial outputs + detail), and partial outputs followed by job
 * failure stay distinguishable from full success.
 */
export interface ImageRun {
  job: string;
  state: ImageRunState;
  outputs: GeneratedImage[];
  detail: string | null;
}

/** One API-format graph node: class plus named inputs. */
export interface ApiGraphNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

/** Pinned API-format graph: node id to node. */
export type ApiGraph = Record<string, ApiGraphNode>;

/**
 * Versioned workflow-node mapping. Adapter-owned typed configuration,
 * NOT language syntax: it lives in the deployment binding (or a
 * versioned template record at the S8 join), is validated against the
 * pinned graph digest at submit, and frozen per run.
 */
export interface WorkflowNodeMapping {
  /** Immutable workflow artifact id (never a path or URL). */
  workflow: string;
  /** Pinned graph digest the mapping was reviewed against (`sha256:` hex). */
  graphDigest: string;
  /** Business field to graph node/key destination; exactly the input fields. */
  inputs: Record<string, { node: string; key: string }>;
  /** Declared output node ids; only these nodes' images are collected. */
  outputs: string[];
}
