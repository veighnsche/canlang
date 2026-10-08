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
 * shapes (money, datetime) are lane-2 types imported below; their wire
 * encodings travel through L2 codecs with exact-value tags (CONTRACTS.md).
 */

import type { FinalizedFileRef } from './files.js';
import type { CanDuration, CanInt, DatetimeValue, DecimalValue, WireMoney } from './values.js';
import type { Bcp47Tag } from './presentation.js';

/**
 * This contract's version. Added by T13a (the T12 inventory noted
 * `services.ts` had no contract version stamp); value shapes below are
 * versioned by it, capability contracts carry their own `STD_*_VERSION`.
 */
export const SERVICES_CONTRACT_VERSION = 1;

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
 * Frozen request for a checked bound send, carried in the existing outbox
 * record. The outbox source/target supplies the canonical operation identity.
 * Routing comes from the selected source binding, never authored inputs or
 * credentials. Dispatch must still verify the installed binding and current
 * authority; this snapshot grants neither and must not select an alias fallback.
 */
export interface BoundCapabilityRequest {
  /** Exact package-qualified key in the owning appDefinition.bindings. */
  readonly binding: string;
  /** Checked deployment route of that binding, e.g. `deployment.mail`. */
  readonly from: string;
  /** Only checked, wire-encoded inputs reach the provider operation. */
  readonly arguments: Readonly<Record<string, unknown>>;
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

/**
 * `std.EmailV1` send inputs (DESIGN section 8).
 *
 * T13a/B9 record: `attachments` stays REQUIRED (no `?`, no default).
 * DESIGN spells `attachments:file[]=[]`, and all 40 corpus `Mail.send`
 * sends plus all 13 recipes supply only `{to, subject, body}` — T14a
 * must rule default-empty vs required. T13a preserves required and
 * encodes no default; flagged for T14a, not silently relaxed.
 */
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
  amount: WireMoney;
  status: 'pending' | 'unknown' | 'succeeded' | 'failed';
  checkout_url: string | null;
  failure: 'transient' | 'action_required' | 'permanent' | 'cancelled' | null;
}

/** `std.PaymentsV1` collect inputs. Consent text is not proof of mandate. */
export interface PaymentCollectInput {
  customer: string;
  /** Lane-2 money wire shape; must be positive. */
  amount: WireMoney;
  reference: string;
  consent: string | null;
}

/** `std.PaymentsV1` refund inputs; a refund has its own logical reference. */
export interface PaymentRefundInput {
  payment: string;
  /** Lane-2 money wire shape; must be positive. */
  amount: WireMoney;
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
  /** Lane-2 datetime value; wire encoding via L2 codecs. */
  occurred_at: DatetimeValue;
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

/* -- T13a canonical common-interface schemas (L4 producer slice). -- */

/**
 * T13a scope: `std.EmailV1` send plus the accepted common value shapes
 * (`DeliveryResult`, `DeliveryError`, `OperationOutcome`, `PaymentState`)
 * and contract-only `std.ErrorsV1` / `std.PaymentsV1` (B10, below). Each
 * operation below is one durable send effect: `send Target.op {…}`
 * persists work and returns a `delivery(Target.op)` association observed
 * per `work.ts` (`ReceiptObservation`, `T13A_DELIVERY_OBSERVABLES`);
 * completions arrive as typed `Target.completed` envelopes
 * (`CapabilityCompletion<R>`). Preserved blockers, NOT decided here:
 * B1 (`std` resolution mechanism), B11 (bound `DeliveryResult`
 * normalization) and B12 (in-corpus binding semantics) belong to
 * T13-consume/T28. T13b rich relations (images/judgment/mailbox/
 * knowledge) are out of this slice: nothing below declares them.
 */

/** `std.EmailV1` contract version; equals `STD_EMAIL_V1_CONTRACT.version`. */
export const STD_EMAIL_V1_VERSION = 1;

/** `std.ErrorsV1` contract version; equals `STD_ERRORS_V1_CONTRACT.version`. */
export const STD_ERRORS_V1_VERSION = 1;

/** `std.PaymentsV1` contract version; equals `STD_PAYMENTS_V1_CONTRACT.version`. */
export const STD_PAYMENTS_V1_VERSION = 1;

/**
 * Canonical `std.EmailV1` contract (DESIGN section 8: `send(to:email,
 * subject:text, body:text, attachments:file[]=[]) -> EmailAccepted`).
 * Adapter-backed (`EmailV1Adapter`; `SERVICES_CATALOG` advertises `send`).
 * `reconcile` is a port op (`MailSender.reconcile`), deliberately NOT a
 * contract op here: it reuses the original delivery id and is never sent
 * from source. No declared events.
 */
export const STD_EMAIL_V1_CONTRACT: CapabilityContract = {
  name: 'std.EmailV1',
  version: STD_EMAIL_V1_VERSION,
  operations: [
    {
      name: 'send',
      inputs: {
        to: 'email',
        subject: 'text',
        body: 'text',
        attachments: 'file[]',
      },
      result: 'EmailAccepted',
    },
  ],
  events: [],
};

/**
 * Canonical `std.ErrorsV1` contract (DESIGN section 8: `report(event:
 * ErrorReport) -> ErrorAccepted`; cf. draft `send Catch.report
 * {event=event}`, CanDo.can:115). B10 CONTRACT-ONLY export: accepted
 * contract shape, no adapter exists — for T13a/T14a checking (runtime
 * via controlled fixtures, adapters later). Do NOT add to
 * `SERVICES_CATALOG`; no events.
 */
export const STD_ERRORS_V1_CONTRACT: CapabilityContract = {
  name: 'std.ErrorsV1',
  version: STD_ERRORS_V1_VERSION,
  operations: [
    {
      name: 'report',
      inputs: {
        event: 'ErrorReport',
      },
      result: 'ErrorAccepted',
    },
  ],
  events: [],
};

/**
 * Canonical `std.PaymentsV1` contract (DESIGN section 8: `collect`,
 * `refund`, `cancel`, `reconcile`, all `-> PaymentState`; verified
 * `changed` event carries the same state). B10 CONTRACT-ONLY export:
 * accepted contract shapes, no adapter exists — for T13a/T14a checking
 * (runtime via controlled fixtures, adapters later). Do NOT add to
 * `SERVICES_CATALOG`. The `changed` fields flatten `PaymentState` (the
 * draft consumes `event` directly as `PaymentState`, CanInvoice.can:469).
 */
export const STD_PAYMENTS_V1_CONTRACT: CapabilityContract = {
  name: 'std.PaymentsV1',
  version: STD_PAYMENTS_V1_VERSION,
  operations: [
    {
      name: 'collect',
      inputs: {
        customer: 'text',
        amount: 'money',
        reference: 'text',
        consent: 'text?',
      },
      result: 'PaymentState',
    },
    {
      name: 'refund',
      inputs: {
        payment: 'text',
        amount: 'money',
        reference: 'text',
      },
      result: 'PaymentState',
    },
    {
      name: 'cancel',
      inputs: {
        reference: 'text',
      },
      result: 'PaymentState',
    },
    {
      name: 'reconcile',
      inputs: {
        reference: 'text',
      },
      result: 'PaymentState',
    },
  ],
  events: [
    {
      name: 'changed',
      fields: {
        reference: 'text',
        revision: 'int',
        provider_reference: 'text?',
        amount: 'money',
        status: 'enum(pending,unknown,succeeded,failed)',
        checkout_url: 'url?',
        failure: 'enum(transient,action_required,permanent,cancelled)?',
      },
    },
  ],
};

/* -- T13b canonical rich-relation schemas (L4 producer slice). -- */

/**
 * T13b scope: `std` generation / image / mailbox relations plus the
 * judgment and knowledge `std` value shapes. Layout note: the T13a
 * sections above are frozen byte-meaning, so every T13b declaration
 * is appended here (values and contracts together) rather than
 * interleaved; nothing above this line changed except the
 * `CanDuration` import.
 *
 * Per-blocker decisions (evidence interface-inventory.md sections B
 * and E; B1/B11/B12 preserved for T13-consume/T28, untouched here):
 *
 * - B2 NEW-CONTRACT: corpus `TextGenerationV1` + `TextMessage` /
 *   `TextRequest` / `TextRun` is NOT `ai.ChatV1` renamed. The draft
 *   shapes are app-level correlation / progress / accounting
 *   (`source`, `revision`, profile/policy keys, token budgets,
 *   `used_tokens`, `detail`; CanChat.can:49-50 fixtures), while
 *   `ModelChatInput` / `ModelChatReply` / `ModelRunSnapshot` are
 *   provider wire (model allowlist, NDJSON streaming, finish
 *   reasons, thinking separation; ollama.ts). Renaming would force
 *   apps to speak provider wire and corrupt CanChat accounting.
 *   `std.TextGenerationV1` is therefore a new canonical contract;
 *   `ai.ChatV1` wire stays untouched and the T24 runtime join maps
 *   `TextRequest` onto `ModelChatInput`.
 * - B3 RECONCILE: the canonical source form for stop/recovery sends
 *   is the draft-evidenced `{source, revision}` durable send
 *   (CanChat.can:120-127, CanCreative.can:128-135); the port forms
 *   (`MediaPort.cancel(job)` / `reconcile(job)`, `reconcile
 *   (deliveryId)`, the chat stream-handle `cancel()`) stay as the
 *   runtime mapping targets owned by the T24 join, which resolves
 *   `(source, revision)` through the delivery association. No port
 *   is renamed. Mailbox reconcile is source-addressed only
 *   (`{source}`, CanInbox.can:227) and stays so.
 * - B4 NEW-CONTRACT (contract-only): `Images.inspect` / `Images.
 *   validate` have no producer — `substituteAndValidate` is
 *   explicitly "not a side-effect-free publish validator for
 *   arbitrary graphs" (mapping.ts). The shapes are fully evidenced
 *   (`inspect {graph}` -> inspection `.fields` of
 *   `{node,key,kind,label}`, CanCreative.can:68/270-272; `validate
 *   {value}` -> `WorkflowValidation {valid,digest,detail}`,
 *   CanCreative.can:76-77/82/47), so they land as contract-only ops
 *   (B10 precedent) for T13b/T14b checking; runtime joins later.
 *   Scoping out would block the whole CanCreative template /
 *   validation flow.
 * - B5 NEW-CONTRACT: `WorkflowInput` / `WorkflowDefinition` /
 *   `WorkflowInspection` / `WorkflowValidation` / `ImageRequest`
 *   are new canonical value schemas from draft evidence. `ImageRun`
 *   / `GeneratedImage` need two layers: the existing provider-owned
 *   interfaces stay as the `ai.ImagesV1` wire (job reference,
 *   downloaded bytes; renaming would break the media adapter and
 *   its scenario tables, out of T13b write scope), while the
 *   draft-evidenced std delivery-progress relation (`{source,
 *   revision, sequence, state, outputs, charged_jobs, detail}` with
 *   file outputs, CanCreative.can:52-56 and CanGallery.can:49-52 in
 *   two apps) lands as `ImageRunProgress` / `ImageFileOutput`.
 *   Contract result names below use the SOURCE names (`ImageRun`)
 *   so L1 binds draft usage; the TS mapping is documented per op.
 *   The T27 join maps provider bytes onto finalized files.
 * - B6 NEW-CONTRACT (contract-only): `std.MailboxV1` +
 *   `IncomingEmail` / `MailReply` / `MailReplyOutcome` + the
 *   `received` verified-ingress event, all from CanInbox evidence
 *   (fixtures CanInbox.can:79-84, `sent`/`reconciled` handlers
 *   :248-301, `received` handler :102-121). No producer of any
 *   kind exists, but the evidence is complete and precise; the B10
 *   precedent (contract-only checking, runtime via fixtures)
 *   applies, and scoping out would block the entire CanInbox
 *   `Post.*` flow.
 * - B7 RECONCILE (two joined layers, no new std capability):
 *   source-owned judgment declarations derive their typed evaluation
 *   interface and result. `std.JudgmentSpec` retains the normalized
 *   source-language questions, ordered options/levels, declaration,
 *   canonical version and text revision (DESIGN §8.2/§13.1; accepted
 *   Inbox judgment typing contract). Provider-owned
 *   `JudgmentBatchInput` / `JudgmentBatchResult` remain the low-level
 *   `ai.SystemOneV1` wire; normalization joins those answers to the
 *   frozen declaration without changing that provider API.
 * - B8 SPLIT: `KnowledgeRequest` / `IndexState` are NEW-CONTRACT
 *   std value schemas from CanKnowledge evidence (fixtures
 *   :80-82, `ask` :157, index reads :281-284/336). The `corpus
 *   Handbook` executable/member interface (`answer` / `cancel` /
 *   `reconcile` / `refresh` / `status` / `available`, `Run` /
 *   `Answer` members) is SCOPED OUT: unlike deployment-bound std
 *   capabilities, the corpus decl kind derives members from
 *   model/scope/where clauses with retrieval-authorization and
 *   index machinery spanning L3/T28 — inventing it here would be
 *   new provider/runtime semantics under the T12 restraint.
 *   Blocked until a corpus-interface decision: CanKnowledge `ask`,
 *   `stop`, `reconcile`, `release_skipped`, `progressed`,
 *   `read_answer`, `reindex` and the Question `coverage` / `answer`
 *   / `state` derives.
 *
 * Every contract below is one durable send effect per op (`send
 * Target.op {…}` persists work; `delivery(Target.op)` observes per
 * `work.ts` `T13B_DELIVERY_OBSERVABLES`; completions arrive as
 * typed `Target.completed` envelopes). `.completed` / `.progressed`
 * are generic delivery-lifecycle events owned by work machinery,
 * not per-contract events, so no contract below declares them;
 * only the `MailboxV1.received` verified-ingress event is
 * capability-specific (Payments `changed` precedent). No entry is
 * added to `SERVICES_CATALOG`: the std contracts are contract-only
 * until the T24 runtime join maps them onto the adapter-backed
 * `ai.*` capabilities (T12 section-F restraint, T13a precedent).
 */

/** `std.TextGenerationV1` contract version. */
export const STD_TEXT_GENERATION_V1_VERSION = 1;

/** `std.ImagesV1` contract version. */
export const STD_IMAGES_V1_VERSION = 1;

/** `std.MailboxV1` contract version. */
export const STD_MAILBOX_V1_VERSION = 1;

/**
 * `std` text message role. Exactly the three draft-evidenced roles
 * (`system` seeds the frozen history, CanChat.can:76; `user` /
 * `assistant` carry the transcript). No `tool` role: nothing in
 * corpus uses tool calls, and adding one would be new semantics.
 */
export type TextMessageRole = 'system' | 'user' | 'assistant';

/**
 * `std` text message (CanChat.can:5,13,76). Attachments are
 * finalized file refs treated as untrusted information, never as
 * instructions (CanChat.can:9 system prompt).
 */
export interface TextMessage {
  role: TextMessageRole;
  content: string;
  attachments: FinalizedFileRef[];
}

/**
 * `std` text generation request value (CanChat.can:49-50 fixtures,
 * :77 construction). Correlation-first: `source` (usually the
 * originating operation id) + `revision` address the run for later
 * `cancel` / `reconcile`; profile/policy keys select deployment
 * configuration; budgets bound the run. The T24 join maps this onto
 * `ModelChatInput` (messages + model + output budget).
 */
export interface TextRequest {
  source: string;
  revision: number;
  profile: string;
  policy_revision: string;
  messages: TextMessage[];
  max_input_tokens: number;
  max_output_tokens: number;
  /** Lane-2 duration value (integer ms); wire encoding via L2 codecs. */
  max_duration: CanDuration;
}

/**
 * Shared rich-run progress state for `std` text and image delivery
 * progress relations (CanChat `reply_progressed`, CanCreative
 * `image_progressed`, CanKnowledge `Question.state`). Observed
 * subsets: chat shows running/succeeded/failed/unknown/cancelled
 * (CanChat.can:170-174), images show queued/succeeded/failed/
 * unknown/cancelled (CanCreative.can:175-179); the union matches
 * the provider `ModelRunState` / `ImageRunState` unions so the T24
 * join maps states 1:1.
 */
export type RunProgressState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled';

/**
 * `std` text run progress relation: the typed result/progress of a
 * `delivery(LLM.generate)` association (CanChat.can:49 fixture,
 * :17-19 derives). `sequence` orders snapshots within one run;
 * `used_tokens` is null until the provider measures usage and is
 * then charged once against the frozen reservation (CanChat
 * .can:158-162); `detail` is safe diagnostic text or null.
 */
export interface TextRun {
  source: string;
  revision: number;
  sequence: number;
  state: RunProgressState;
  content: string;
  used_tokens: number | null;
  detail: string | null;
}

/**
 * `std` workflow input destination: one business field bound to a
 * graph node/key (CanCreative.can:17,48). Authored mapping, not
 * provider discovery.
 */
export interface WorkflowInput {
  node: string;
  key: string;
}

/**
 * `std` immutable workflow definition snapshot: the draft graph
 * file plus the four bound business fields (CanCreative.can:17-18,
 * :48). Frozen per revision; later draft edits cannot change it.
 */
export interface WorkflowDefinition {
  graph: FinalizedFileRef;
  prompt: WorkflowInput;
  negative: WorkflowInput;
  width: WorkflowInput;
  height: WorkflowInput;
}

/**
 * One inspected graph input field (CanCreative.can:270-272 page
 * reads: `row.node,row.key,row.kind,row.label`). `kind` / `label`
 * vocabs are unobserved in corpus and stay open text; a closed
 * vocab needs provider evidence, not invention here.
 */
export interface WorkflowField {
  node: string;
  key: string;
  kind: string;
  label: string;
}

/**
 * `std` workflow inspection result: the allowed input destinations
 * of one graph, without starting a generation
 * (CanCreative.can:65-69).
 */
export interface WorkflowInspection {
  fields: WorkflowField[];
}

/**
 * `std` workflow validation result (CanCreative.can:47 fixture,
 * :82 publish gate). `digest` is present exactly when `valid` (the
 * publish gate requires both); `detail` carries safe rejection
 * text or null.
 */
export interface WorkflowValidation {
  valid: boolean;
  digest: string | null;
  detail: string | null;
}

/**
 * `std` image generation request value (CanCreative.can:52-56
 * fixtures, :103 construction). `workflow` is the frozen published
 * definition, `validation` its published digest; the run is
 * bounded by `max_outputs` / `max_duration`. Width/height
 * multiple-of-64 is app invariant (CanCreative.can:35/95), not a
 * contract rule.
 */
export interface ImageRequest {
  source: string;
  revision: number;
  workflow: WorkflowDefinition;
  validation: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  max_outputs: number;
  /** Lane-2 duration value (integer ms); wire encoding via L2 codecs. */
  max_duration: CanDuration;
}

/**
 * One finalized image output (source name `GeneratedImage`,
 * CanCreative.can:52, CanGallery.can:49). The `image` is a
 * receiving-app finalized file produced by the T27 join — never
 * provider bytes (those are the wire `GeneratedImage.bytes`) and
 * never a provider URL.
 */
export interface ImageFileOutput {
  position: number;
  image: FinalizedFileRef;
}

/** Canonical source GeneratedImage fields; file wire shape grants no provenance or authority. */
export const GENERATED_IMAGE_FIELDS = Object.freeze([
  Object.freeze({ name: 'position', type: 'int' }),
  Object.freeze({ name: 'image', type: 'file' }),
]);

/**
 * `std` image run progress relation (source name `ImageRun`): the
 * typed result/progress of a `delivery(Images.submit)` association
 * (CanCreative.can:52-56 fixtures, :19-20 derives, :157-172
 * handler; CanGallery.can:48-52 witness the same shape in a second
 * app). `charged_jobs` is null until measured, then charged once
 * (CanCreative.can:164-166); a failed run still carries partial
 * outputs as data (CanCreative.can:179). Distinct from the
 * provider-owned wire `ImageRun` (`{job, state, outputs, detail}`
 * with byte outputs), which stays as the `ai.ImagesV1`
 * observation the T27 join finalizes from.
 */
export interface ImageRunProgress {
  source: string;
  revision: number;
  sequence: number;
  state: RunProgressState;
  outputs: ImageFileOutput[];
  charged_jobs: number | null;
  detail: string | null;
}

/**
 * `std` incoming email value (CanInbox.can:79 fixture). `reply_to`
 * is nullable (null-checked, CanInbox.can:190); every other leaf
 * is required as fixture-evidenced. `attachments` holds finalized
 * refs up to `attachment_count`; `attachments_complete` tells
 * whether the set is whole (CanInbox.can:49 invariant).
 * Attachment bytes are evidence, never instructions (CanInbox
 * .can:13).
 */
export interface IncomingEmail {
  mailbox: string;
  source: string;
  thread: string;
  sender: string;
  reply_to: string | null;
  subject: string;
  body: string;
  body_complete: boolean;
  attachments: FinalizedFileRef[];
  attachment_count: number;
  attachments_complete: boolean;
  /** Lane-2 datetime value; wire encoding via L2 codecs. */
  received: DatetimeValue;
}

/**
 * `std` reviewed reply value (CanInbox.can:81 fixture, :209
 * construction). Frozen at submit; the send carries it by value
 * (`Post.reply {value=request}`, CanInbox.can:212) and the
 * invariant binds every leaf back to the frozen reply
 * (CanInbox.can:53).
 */
export interface MailReply {
  source: string;
  mailbox: string;
  message: string;
  to: string;
  subject: string;
  body: string;
  attachments: FinalizedFileRef[];
}

/**
 * `std` mail reply outcome state. `accepted` and `not_sent` are
 * fixture-observed (CanInbox.can:273-274); `unknown` covers the
 * `sent`/`reconciled` else arm (CanInbox.can:261/293), which maps
 * any other provider state to uncertain — unknown is never
 * non-send proof.
 */
export type MailReplyState = 'accepted' | 'not_sent' | 'unknown';

/**
 * `std` mail reply outcome: the typed result of `Post.reply` and
 * `Post.reconcile` completions (CanInbox.can:253-261/285-293
 * handlers read `source`/`state`/`reference`/`detail`).
 * `reference` is present exactly for `accepted` sends (CanInbox
 * .can:54 invariant).
 */
export interface MailReplyOutcome {
  source: string;
  state: MailReplyState;
  reference: string | null;
  detail: string | null;
}

/** One source-retained judgment option or ordered score level. */
export interface JudgmentOption {
  readonly id: string;
  readonly description: string;
}

/** Source-language NOUL question; yes/no criteria are both present or both null. */
export interface NoulQuestion {
  readonly id: string;
  readonly instructions: string;
  readonly yes: string | null;
  readonly no: string | null;
}

/** Source-language choice question with declaration-ordered options. */
export interface ChoiceQuestion {
  readonly id: string;
  readonly instructions: string;
  readonly options: ReadonlyArray<JudgmentOption>;
}

/** Source-language score question; level insertion order is semantic. */
export interface ScoreQuestion {
  readonly id: string;
  readonly instructions: string;
  readonly levels: ReadonlyArray<JudgmentOption>;
}

/**
 * `std` frozen normalized judgment specification (DESIGN §8.2/§13.1;
 * accepted Inbox judgment typing contract). Source-language strings and
 * ordered identities derive from the owning declaration; display
 * localization does not change inference or its canonical text revision.
 * Each question-kind array may be empty; the accepted suite is nonempty
 * in total. Provider request/result normalization remains adapter-owned.
 */
export interface JudgmentSpec {
  readonly declaration: string;
  readonly version: CanInt;
  readonly revision: string;
  readonly language: Bcp47Tag;
  readonly noul: ReadonlyArray<NoulQuestion>;
  readonly choice: ReadonlyArray<ChoiceQuestion>;
  readonly score: ReadonlyArray<ScoreQuestion>;
}

/** Canonical NOUL answer; probability has no invented confidence field. */
export interface JudgmentNoulAnswer {
  readonly probability: DecimalValue;
}

/** Canonical choice answer; generated schemas retain the exact option enum. */
export interface JudgmentChoiceAnswer {
  readonly choice: string;
  readonly probabilities: ReadonlyArray<{
    readonly option: string;
    readonly probability: DecimalValue;
  }>;
  readonly confidence: DecimalValue;
}

/** Canonical score answer; levels preserve the frozen specification order. */
export interface JudgmentScoreAnswer {
  readonly score: DecimalValue;
  readonly levels: ReadonlyArray<{
    readonly level: string;
    readonly index: CanInt;
    readonly description: string;
    readonly probability: DecimalValue;
  }>;
  readonly confidence: DecimalValue;
}

/**
 * Shared dynamic judgment result envelope. The compiler derives exact
 * named question fields and schemas and excludes reserved metadata names.
 */
export interface JudgmentEvaluationResult {
  readonly specification_revision: string;
  readonly model: string;
  readonly input_tokens: CanInt;
  readonly output_tokens: CanInt;
  readonly [question: string]: string | CanInt | JudgmentNoulAnswer | JudgmentChoiceAnswer | JudgmentScoreAnswer;
}

/**
 * `std` grounded-question request value (CanKnowledge.can:80-83
 * fixtures, :157 construction). Same budget envelope as
 * `TextRequest` with the transcript replaced by one `question`;
 * retrieval scope travels beside it (`Handbook.answer
 * {scope=topic,value}`, CanKnowledge.can:82/159 — corpus member,
 * scoped out of T13b with the Handbook interface, see B8).
 */
export interface KnowledgeRequest {
  source: string;
  revision: number;
  question: string;
  profile: string;
  policy_revision: string;
  max_input_tokens: number;
  max_output_tokens: number;
  /** Lane-2 duration value (integer ms); wire encoding via L2 codecs. */
  max_duration: CanDuration;
}

/**
 * `std` source-index readiness (CanKnowledge.can:26 derive,
 * :281-284/336 reads of `.state` / `.checked` / `.detail`).
 * `state` stays open text — no state value is observed in corpus
 * and a closed vocab would be invention. `checked` is the last
 * index-check timestamp (single-read inference from the
 * "Index readiness" label + text rendering; T14b may widen with
 * evidence). `detail` follows the sibling nullable-text detail
 * convention (`TextRun.detail`, `ImageRunProgress.detail`).
 */
export interface IndexState {
  state: string;
  /** Lane-2 datetime value; wire encoding via L2 codecs. */
  checked: DatetimeValue | null;
  detail: string | null;
}

/**
 * Canonical `std.TextGenerationV1` contract (B2 new-contract; binds
 * `deployment.llm`, CanChat.can:6). `generate` carries the frozen
 * request by value; `cancel` / `reconcile` address the run by its
 * frozen `(source, revision)` identity (B3). The chat port has no
 * `cancel` op (stream-handle only) — the contract still declares
 * the durable intent and T24 resolves it through the delivery
 * association; no port is renamed. Cancel/reconcile results are
 * symmetric-inference `TextRun` observations (no corpus result
 * reads exist for them; cf. `MediaPort.cancel` -> `ImageRun` at
 * the wire layer). Contract-only: do NOT add to
 * `SERVICES_CATALOG` (T12 section-F restraint). No declared
 * events (`.progressed` is generic delivery lifecycle).
 */
export const STD_TEXT_GENERATION_V1_CONTRACT: CapabilityContract = {
  name: 'std.TextGenerationV1',
  version: STD_TEXT_GENERATION_V1_VERSION,
  operations: [
    {
      name: 'generate',
      inputs: {
        value: 'TextRequest',
      },
      result: 'TextRun',
    },
    {
      name: 'cancel',
      inputs: {
        source: 'text',
        revision: 'int',
      },
      result: 'TextRun',
    },
    {
      name: 'reconcile',
      inputs: {
        source: 'text',
        revision: 'int',
      },
      result: 'TextRun',
    },
  ],
  events: [],
};

/**
 * Canonical `std.ImagesV1` contract (B4/B5 new-contract; binds
 * `deployment.images`, CanCreative.can:9). `inspect` reads allowed
 * input destinations without generating; `validate` freezes a
 * definition snapshot for publish gating; `submit` / `cancel` /
 * `reconcile` follow the generation lifecycle with
 * `(source, revision)` addressing (B3). Result name `ImageRun` is
 * the SOURCE name and denotes the std delivery-progress relation
 * (TS `ImageRunProgress`), NOT the provider-owned wire `ImageRun`
 * (job + byte outputs); nested file outputs are TS
 * `ImageFileOutput` (source `GeneratedImage`). Cancel/reconcile
 * results are symmetric-inference observations (no corpus result
 * reads; wire precedent `MediaPort.cancel/reconcile` ->
 * `ImageRun`). Contract-only: do NOT add to `SERVICES_CATALOG`.
 * No declared events.
 */
export const STD_IMAGES_V1_CONTRACT: CapabilityContract = {
  name: 'std.ImagesV1',
  version: STD_IMAGES_V1_VERSION,
  operations: [
    {
      name: 'inspect',
      inputs: {
        graph: 'file',
      },
      result: 'WorkflowInspection',
    },
    {
      name: 'validate',
      inputs: {
        value: 'WorkflowDefinition',
      },
      result: 'WorkflowValidation',
    },
    {
      name: 'submit',
      inputs: {
        value: 'ImageRequest',
      },
      result: 'ImageRun',
    },
    {
      name: 'cancel',
      inputs: {
        source: 'text',
        revision: 'int',
      },
      result: 'ImageRun',
    },
    {
      name: 'reconcile',
      inputs: {
        source: 'text',
        revision: 'int',
      },
      result: 'ImageRun',
    },
  ],
  events: [],
};

/**
 * Canonical `std.MailboxV1` contract (B6 new-contract, contract-only;
 * binds `deployment.inbox`, CanInbox.can:9). `reply` sends the
 * frozen reviewed reply by value; `reconcile` re-checks the
 * original provider identity by `{source}` only (CanInbox.can:227)
 * and carries the same outcome result. The `received` event is a
 * verified-ingress event (Payments `changed` precedent): its
 * single `value` field carries the whole `IncomingEmail`
 * (CanInbox.can:104-110 reads `event.value` as the envelope).
 * Contract-only: do NOT add to `SERVICES_CATALOG`.
 */
export const STD_MAILBOX_V1_CONTRACT: CapabilityContract = {
  name: 'std.MailboxV1',
  version: STD_MAILBOX_V1_VERSION,
  operations: [
    {
      name: 'reply',
      inputs: {
        value: 'MailReply',
      },
      result: 'MailReplyOutcome',
    },
    {
      name: 'reconcile',
      inputs: {
        source: 'text',
      },
      result: 'MailReplyOutcome',
    },
  ],
  events: [
    {
      name: 'received',
      fields: {
        value: 'IncomingEmail',
      },
    },
  ],
};
