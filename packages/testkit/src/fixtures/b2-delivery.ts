/**
 * B2 delivery-journey fixtures (L7): seed vocabulary, journey-row plan and
 * structural guards for the mail notice leg over the landed playback
 * endpoint. Workerd-safe: no `node:` imports (same rule as `playback.ts`).
 *
 * The journey rows in `tests/integration/b2-delivery.test.ts` drive the
 * REAL L4 mail adapter against the REAL L4 scenario tables served by the
 * REAL `createPlaybackHandler`, and check every observed completion
 * against the `CapabilityCompletion` envelope rule
 * (`packages/contracts/src/services.ts`:
 * succeeded carries result with null error; failed carries null result
 * with non-null error; unknown carries null result; skipped carries null
 * result and null error).
 *
 * This module imports NOTHING from services source — not even types
 * (same precedent as `playback.ts`: `@canlang/services` has no build,
 * and TS-source imports break the testkit emit). Adapter/seed shapes
 * below mirror L4's contracts structurally, and the spec fails loud
 * when the loaded producer drifts from them.
 */

/** `<scenario>.<provider>.playback` host for one seed ref. */
export function playbackSeedHost(seedRef: string): string {
  const parts = seedRef.split(":");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new Error(`invalid seed ref ${JSON.stringify(seedRef)}: expected "<provider>:<scenario>"`);
  }
  return `${parts[1]}.${parts[0]}.playback`;
}

/** Deterministic delivery identity for one journey row. */
export function b2DeliveryId(rowIndex: number): string {
  return `b2-delivery-row-${rowIndex}`;
}

/** How the spec drives one seed: single send, or send-then-reconcile. */
export type B2MailFlow = "send" | "send-retry" | "send-reconcile";

/**
 * The B2 mail journey over playback: every L4 mail scenario table, each
 * with its flow shape and the completion status the real adapter must
 * report. `skipped` never appears here — only the dispatch executor
 * emits it (P-B2c, unlanded), and adapters never do.
 */
export interface B2MailJourneyRow {
  readonly seed: string;
  readonly flow: B2MailFlow;
  /** Expected `status` of the send completion (`send-retry`: first attempt). */
  readonly sendStatus: "succeeded" | "failed" | "unknown";
  /** Expected `error.code` of the send completion, or null when no error. */
  readonly sendErrorCode: string | null;
  /** Expected `status` of the follow-up (`send-retry`: second attempt with the same delivery id; `send-reconcile`: reconcile under the original identity). */
  readonly followupStatus: "succeeded" | "failed" | "unknown" | null;
  /** Expected `error.code` of the follow-up, or null when no error. */
  readonly followupErrorCode: string | null;
}

export const B2_MAIL_JOURNEY: readonly B2MailJourneyRow[] = [
  { seed: "mail:send-ok", flow: "send", sendStatus: "succeeded", sendErrorCode: null, followupStatus: null, followupErrorCode: null },
  { seed: "mail:send-reject", flow: "send", sendStatus: "failed", sendErrorCode: "provider_rejected", followupStatus: null, followupErrorCode: null },
  { seed: "mail:send-rate-limited", flow: "send", sendStatus: "unknown", sendErrorCode: "provider_rate_limited", followupStatus: null, followupErrorCode: null },
  { seed: "mail:send-client-timeout", flow: "send", sendStatus: "unknown", sendErrorCode: "provider_client_timeout", followupStatus: null, followupErrorCode: null },
  { seed: "mail:send-retry-success", flow: "send-retry", sendStatus: "unknown", sendErrorCode: "provider_transient", followupStatus: "succeeded", followupErrorCode: null },
  { seed: "mail:send-unknown-accepted", flow: "send-reconcile", sendStatus: "unknown", sendErrorCode: "transport_timeout", followupStatus: "succeeded", followupErrorCode: null },
  { seed: "mail:send-unknown-rejected", flow: "send-reconcile", sendStatus: "unknown", sendErrorCode: "transport_timeout", followupStatus: "failed", followupErrorCode: "provider_rejected" },
  { seed: "mail:send-unknown-pending", flow: "send-reconcile", sendStatus: "unknown", sendErrorCode: "transport_timeout", followupStatus: "unknown", followupErrorCode: null },
  { seed: "mail:send-invalid-schema", flow: "send", sendStatus: "failed", sendErrorCode: "invalid_response", followupStatus: null, followupErrorCode: null },
  { seed: "mail:send-redirect-refused", flow: "send", sendStatus: "unknown", sendErrorCode: "redirect_refused", followupStatus: null, followupErrorCode: null },
  { seed: "mail:send-redirect-loop", flow: "send", sendStatus: "unknown", sendErrorCode: "too_many_redirects", followupStatus: null, followupErrorCode: null },
];

/** Structural mirror of L4's `EmailSendInput` (contracts `services.ts`). */
export interface B2MailInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly attachments: readonly string[];
}

/** The notice input every journey row sends (no attachments: file journey P-B2d unlanded). */
export function b2MailInput(rowIndex: number): B2MailInput {
  return {
    to: "reviewer@example.test",
    subject: `B2 notice row ${rowIndex}`,
    body: `Expense report awaiting approval (journey row ${rowIndex}).`,
    attachments: [],
  };
}

/** Structural mirror of the `CapabilityCompletion` envelope (contracts `services.ts`). */
export interface B2CompletionView {
  readonly delivery_id: unknown;
  readonly status: unknown;
  readonly result: unknown;
  readonly error: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Enforces the `CapabilityCompletion` envelope rule on one observed
 * completion and returns its status + error code. Throws on any
 * deviation (stale adapter, envelope drift, or a non-completion).
 */
export function readB2Completion(
  completion: unknown,
  what: string,
): { status: string; errorCode: string | null } {
  if (!isRecord(completion)) {
    throw new Error(`${what}: completion must be an object`);
  }
  const view = completion as unknown as B2CompletionView;
  if (typeof view.delivery_id !== "string" || view.delivery_id === "") {
    throw new Error(`${what}: completion carries no delivery_id`);
  }
  if (
    view.status !== "succeeded" &&
    view.status !== "failed" &&
    view.status !== "unknown" &&
    view.status !== "skipped"
  ) {
    throw new Error(`${what}: completion status ${JSON.stringify(view.status)} is not a completion`);
  }
  const status: string = view.status;
  if (status === "succeeded" && (view.result === null || view.result === undefined || view.error !== null)) {
    throw new Error(`${what}: succeeded completion must carry result with null error`);
  }
  if (status === "failed" && (view.result !== null || !isRecord(view.error))) {
    throw new Error(`${what}: failed completion must carry null result with an error object`);
  }
  if (status === "unknown" && view.result !== null) {
    throw new Error(`${what}: unknown completion must carry null result`);
  }
  if (status === "skipped" && (view.result !== null || view.error !== null)) {
    throw new Error(`${what}: skipped completion must carry null result and null error`);
  }
  if (view.error === null || view.error === undefined) {
    return { status, errorCode: null };
  }
  if (!isRecord(view.error) || typeof view.error["code"] !== "string") {
    throw new Error(`${what}: completion error must be {code, message}`);
  }
  return { status, errorCode: view.error["code"] };
}

/**
 * Redaction probe: the completion envelope must never carry the notice
 * PII back (subject/body/recipient are provider-bound request data, not
 * safe diagnostics). Throws naming the leaked field.
 */
export function assertB2CompletionRedacted(completion: unknown, input: B2MailInput, what: string): void {
  const text = JSON.stringify(completion);
  for (const [field, secret] of [
    ["subject", input.subject],
    ["body", input.body],
    ["to", input.to],
  ] as const) {
    if (secret !== "" && text.includes(secret)) {
      throw new Error(`${what}: completion leaks notice ${field}`);
    }
  }
}
