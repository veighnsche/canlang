/**
 * Adapter ports: the seams between `@canlang/services` adapters and the
 * runtime, plus the controlled-endpoint test harness.
 *
 * - `MailSender` is the mail port the runtime drives.
 * - `Clock`, `DeliveryIds` and `AttachmentSizes` are injected seams so
 *   tests stay deterministic (fixed clock, sequential ids, fixed sizes).
 * - `startControlledMailServer` spins up a real `node:http` localhost
 *   server with scripted responses. Tests exercise adapters through
 *   REAL fetch against it; the fetch function itself is never stubbed.
 *
 * The scripted scenarios simulate DOCUMENTED provider behavior (accept,
 * reject, transient failure, timeout, invalid schema), not the remote
 * service itself: they assert how the adapter classifies, maps and
 * redacts each outcome.
 */
import type {
  CapabilityCompletion,
  EmailAccepted,
  EmailSendInput,
  ImageAccepted,
  ImageGenerateInput,
  ImageRequest,
  ImageRun,
  JudgmentBatchInput,
  JudgmentBatchResult,
  JudgmentEvaluationResult,
  ModelChatInput,
  ModelChatReply,
  ModelRunSnapshot,
  ProviderBinding,
  TextRequest,
  WorkflowDefinition,
} from '@canlang/contracts';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { readTextBody, sendBody } from './internal/controlled-http.js';
import type { Socket } from 'node:net';
import type { FrozenJudgmentSource } from './judgments/specification.js';

export type MailAttachmentRef = EmailSendInput['attachments'][number];

export interface Clock {
  now(): number;
}

export interface DeliveryIds {
  next(): string;
}

/** Resolves a finalized ref to its byte size; `null` = unknown ref. */
export interface AttachmentSizes {
  sizeOf(ref: MailAttachmentRef): number | null;
}

export interface MailSender {
  /**
   * The runtime always supplies its own stable delivery id; the adapter
   * never mints identity, so caller retries stay idempotent.
   */
  send(
    input: EmailSendInput,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<EmailAccepted>>;
  reconcile(deliveryId: string): Promise<CapabilityCompletion<EmailAccepted>>;
}

/** An actual caller-configured installation, never source inputs, account fallback or discovery. */
export interface InstalledMailSender {
  readonly binding: ProviderBinding;
  readonly mail: MailSender;
}

/**
 * Returns null when missing; supplies the exact deployment for the runtime
 * to verify before guard evaluation or transport.
 */
export type ResolveInstalledMailSender = (
  exactDeployment: string,
) => InstalledMailSender | null;

/**
 * Live handle for one streaming model run. Snapshots are ordered
 * observations (sequence-dense, bounded tail); `cancel()` requests
 * cancellation and resolves with the terminal completion, which may
 * still be the final reply when completion raced cancellation.
 */
export interface ModelRunHandle {
  readonly deliveryId: string;
  /** True once `cancel()` was called (requested, not yet confirmed). */
  readonly cancelRequested: boolean;
  snapshots(): readonly ModelRunSnapshot[];
  cancel(): Promise<CapabilityCompletion<ModelChatReply>>;
  done(): Promise<CapabilityCompletion<ModelChatReply>>;
}

export interface ModelChatPort {
  /**
   * Final-only generation. The runtime always supplies its own stable
   * delivery id; the adapter never mints identity.
   */
  generate(
    input: ModelChatInput,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<ModelChatReply>>;
  /**
   * Streaming generation. Returns the run handle immediately; throws
   * synchronously on validation failures (nothing is sent).
   */
  generateStream(
    input: ModelChatInput,
    options: {
      readonly deliveryId: string;
      readonly onSnapshot?: (snapshot: ModelRunSnapshot) => void;
    },
  ): ModelRunHandle;
  /**
   * Reconcile an uncertain generation through its original identity.
   * Providers without a documented run lookup honestly stay `unknown`.
   */
  reconcile(deliveryId: string): Promise<CapabilityCompletion<ModelChatReply>>;
}

/** Installed std generation accepts its complete budgets, never a lossy chat projection. */
export interface TextGenerationPort {
  generate(
    input: TextRequest,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<ModelChatReply>>;
  generateStream(
    input: TextRequest,
    options: {
      readonly deliveryId: string;
      readonly onSnapshot?: (snapshot: ModelRunSnapshot) => void;
    },
  ): ModelRunHandle;
  reconcile(deliveryId: string): Promise<CapabilityCompletion<ModelChatReply>>;
}

/** Exact deployment-owned identity and ceilings supplied by the actual adapter. */
export interface InstalledTextGeneration {
  readonly binding: Readonly<ProviderBinding>;
  readonly profile: {
    readonly name: string;
    readonly policyRevision: string;
    readonly provider: string;
    readonly model: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly maxDurationMs: number;
    readonly inputTokenization: 'deployment' | 'unsupported';
    readonly attachments: 'unsupported';
  };
  readonly text: TextGenerationPort;
}

/** Missing exact installations return null; aliases and discovery are not fallbacks. */
export type ResolveInstalledTextGeneration = (
  exactDeployment: string,
) => InstalledTextGeneration | null;

export interface JudgmentPort {
  /**
   * Evaluate one typed batch. The runtime always supplies its own
   * stable delivery id; the adapter never mints identity.
   */
  evaluate(
    input: JudgmentBatchInput,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<JudgmentBatchResult>>;
  /**
   * Reconcile an uncertain batch through its original identity.
   * Providers without a documented batch lookup honestly stay `unknown`.
   */
  reconcile(
    deliveryId: string,
  ): Promise<CapabilityCompletion<JudgmentBatchResult>>;
}

/** Source-owned static judgment input; model selection belongs to the installation. */
export interface JudgmentEvaluationInput {
  readonly source: FrozenJudgmentSource;
  readonly state: string;
}

export interface JudgmentEvaluationPort {
  evaluate(
    input: JudgmentEvaluationInput,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<JudgmentEvaluationResult>>;
  reconcile(deliveryId: string): Promise<CapabilityCompletion<JudgmentEvaluationResult>>;
}

/** Exact defining declaration and deployment, with no discovery or model fallback. */
export interface InstalledJudgment {
  readonly binding: {
    readonly judgment: string;
    readonly version: bigint;
    readonly deployment: string;
    readonly account: string;
  };
  readonly profile: {
    readonly provider: string;
    readonly model: string;
    readonly maxInputTokens: number;
    readonly inputTokenization: 'deployment';
  };
  readonly judgment: JudgmentEvaluationPort;
}

export type ResolveInstalledJudgment = (exactDeployment: string) => InstalledJudgment | null;

export interface MediaPort {
  /**
   * Submit a generation. The caller may supply its own job id for
   * crash recovery (an unknown submit with a known id stays
   * pollable); otherwise the adapter mints one.
   */
  submit(
    input: ImageGenerateInput,
    options: { readonly deliveryId: string; readonly jobId?: string },
  ): Promise<CapabilityCompletion<ImageAccepted>>;
  /**
   * Observe one job. A succeeded completion carries the observed run
   * (which may itself be failed or unknown); completion failure
   * means the observation itself failed.
   */
  reconcile(
    job: string,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<ImageRun>>;
  /**
   * Request cancellation, then reconcile. The post-cancel
   * observation is the answer; native polling exposes no
   * `cancelled` marker, so none is fabricated.
   */
  cancel(
    job: string,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<ImageRun>>;
}

/** Caller persists these original identities and deadline alongside the full request. */
export interface InstalledImageOptions {
  readonly deliveryId: string;
  /** Canonical lowercase UUID accepted by native ComfyUI; never reminted. */
  readonly jobId: string;
  /** Original finite Unix millisecond deadline; callers must never renew it. */
  readonly deadlineMs: number;
  /**
   * Independent retained control budget, used only by cancel/reconcile.
   * Persist this original window; a retry must not renew either deadline.
   */
  readonly observation?: {
    readonly startedAtMs: number;
    readonly deadlineMs: number;
  };
}

/**
 * Full std request survives every lifecycle call, including source/revision
 * correlation. Submit uses only the original generation deadline. An expired
 * generation can be observed or cancelled only with a retained control window.
 */
export interface ImagesPort {
  submit(input: ImageRequest, options: InstalledImageOptions): Promise<CapabilityCompletion<ImageAccepted>>;
  reconcile(input: ImageRequest, options: InstalledImageOptions): Promise<CapabilityCompletion<ImageRun>>;
  cancel(input: ImageRequest, options: InstalledImageOptions): Promise<CapabilityCompletion<ImageRun>>;
}

/** One installed graph/map only; this supplies no arbitrary inspection or publish validation. */
export interface InstalledImages {
  readonly binding: Readonly<ProviderBinding>;
  readonly workflow: {
    readonly graph: WorkflowDefinition['graph'];
    readonly prompt: Readonly<WorkflowDefinition['prompt']>;
    readonly negative: Readonly<WorkflowDefinition['negative']>;
    readonly width: Readonly<WorkflowDefinition['width']>;
    readonly height: Readonly<WorkflowDefinition['height']>;
  };
  readonly validation: string;
  readonly policy: {
    readonly seed: { readonly kind: 'fixed'; readonly value: number };
    readonly maxOutputs: number;
    readonly maxDurationMs: number;
    readonly maxObservationDurationMs: number;
    readonly maxOutputBytes: number;
  };
  readonly images: ImagesPort;
}

export type ResolveInstalledImages = (exactDeployment: string) => InstalledImages | null;

export function systemClock(): Clock {
  return { now: () => Date.now() };
}

export function fixedClock(value: number): Clock {
  return { now: () => value };
}

export function sequentialIds(prefix: string): DeliveryIds {
  let next = 0;
  return {
    next: () => {
      next += 1;
      return `${prefix}_${next}`;
    },
  };
}

export function uniqueIds(prefix = 'del'): DeliveryIds {
  return { next: () => `${prefix}_${randomUUID()}` };
}

export function fixedAttachmentSizes(
  entries: Record<string, number>,
): AttachmentSizes {
  return {
    sizeOf: (ref) => {
      const size = entries[ref];
      return typeof size === 'number' ? size : null;
    },
  };
}

/**
 * Scripted provider behaviors:
 * - `accept`: 200 `{reference}` on POST /send.
 * - `reject`: configured 4xx on POST /send; a string body is served raw
 *   (this one kind covers both the plain-reject and the token-in-body
 *   redaction tests).
 * - `flaky-then-accept`: N x 500, then accept (`flaky-then-accept`).
 * - `hang`: records the send as accepted, rejected or still pending
 *   (possible commit) but never responds, so the client times out; GET
 *   /deliveries/{id} then reconciles (`hang-then-timeout`).
 * - `invalid-schema`: 200 with a bogus body on POST /send and a bogus
 *   reconcile payload (`invalid-schema`).
 * - `redirect`: configured 3xx status with the given Location on POST
 *   /send (307 preserves POST to `/send-final`; same-origin 302
 *   converts to GET /send-final; cross-origin targets must be refused
 *   before any second request is sent).
 * - `drip`: 200 headers immediately on POST /send, body delayed by
 *   `delayMs` (covers header-then-drip timeouts).
 */
export type ControlledScenario =
  | { readonly kind: 'accept' }
  | { readonly kind: 'reject'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'flaky-then-accept'; readonly failures: number }
  | { readonly kind: 'invalid-schema'; readonly body: unknown }
  | {
      readonly kind: 'hang';
      readonly reconcile: 'accepted' | 'rejected' | 'pending';
    }
  | {
      readonly kind: 'redirect';
      readonly status: number;
      readonly location: string;
    }
  | { readonly kind: 'drip'; readonly delayMs: number };

export interface ControlledRequestLog {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | null;
  readonly bodyText: string;
  /** Whether an Authorization header was present; the value is never logged. */
  readonly hadAuth: boolean;
}

export interface ControlledMailServer {
  /** Base URL, e.g. `http://127.0.0.1:PORT`. */
  readonly url: string;
  /** Every POST received, in order. */
  readonly requests: readonly ControlledRequestLog[];
  close(): Promise<void>;
}

export function startControlledMailServer(
  scenario: ControlledScenario,
): Promise<ControlledMailServer> {
  return new Promise((resolve, reject) => {
    const requests: ControlledRequestLog[] = [];
    const deliveries = new Map<
      string,
      { outcome: 'accepted' | 'rejected' | 'pending'; reference: string }
    >();
    let counter = 0;
    let sendAttempts = 0;
    const sockets = new Set<Socket>();

    const acceptSend = (
      res: http.ServerResponse,
      idempotencyKey: string | null,
    ): void => {
      // Idempotent: the same key returns the original reference.
      if (idempotencyKey !== null) {
        const existing = deliveries.get(idempotencyKey);
        if (existing !== undefined && existing.outcome === 'accepted') {
          sendBody(res, 200, { reference: existing.reference });
          return;
        }
      }
      counter += 1;
      const reference = `mail_${counter}`;
      deliveries.set(idempotencyKey ?? `anon_${counter}`, {
        outcome: 'accepted',
        reference,
      });
      sendBody(res, 200, { reference });
    };

    const handle = async (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ): Promise<void> => {
      const method = req.method ?? 'GET';
      const rawPath = (req.url ?? '/').split('?')[0];
      const keyHeader = req.headers['idempotency-key'];
      const idempotencyKey =
        typeof keyHeader === 'string' ? keyHeader : null;
      if (method === 'POST' && (rawPath === '/send' || rawPath === '/send-final')) {
        const bodyText = await readTextBody(req);
        requests.push({
          method,
          path: rawPath,
          idempotencyKey,
          bodyText,
          hadAuth: req.headers['authorization'] !== undefined,
        });
        if (rawPath === '/send-final') {
          acceptSend(res, idempotencyKey);
          return;
        }
        switch (scenario.kind) {
          case 'accept':
            acceptSend(res, idempotencyKey);
            return;
          case 'reject':
            sendBody(res, scenario.status, scenario.body);
            return;
          case 'flaky-then-accept':
            sendAttempts += 1;
            if (sendAttempts <= scenario.failures) {
              sendBody(res, 500, { error: 'transient failure' });
              return;
            }
            acceptSend(res, idempotencyKey);
            return;
          case 'invalid-schema':
            sendBody(res, 200, scenario.body);
            return;
          case 'hang': {
            // Possible commit: the send took effect server-side but the
            // response is lost, so the client must time out to unknown
            // and reconcile through the original identity.
            counter += 1;
            const reference = `mail_${counter}`;
            deliveries.set(idempotencyKey ?? `anon_${counter}`, {
              outcome: scenario.reconcile,
              reference,
            });
            return; // Never respond.
          }
          case 'redirect':
            res.writeHead(scenario.status, {
              location: scenario.location,
              'content-length': '0',
            });
            res.end();
            return;
          case 'drip': {
            const text = JSON.stringify({ reference: 'mail_drip' });
            res.writeHead(200, {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(text),
            });
            setTimeout(() => {
              try {
                if (!res.destroyed) {
                  res.end(text);
                }
              } catch {
                // Client already gone (e.g. timed out).
              }
            }, scenario.delayMs);
            return;
          }
        }
      }
      if (method === 'GET' && rawPath === '/send-final') {
        // Same-origin 302 target: proves POST-to-GET conversion, since a
        // re-POST would return an acceptSend `mail_N` reference instead.
        sendBody(res, 200, { reference: 'mail_get' });
        return;
      }
      if (method === 'GET' && rawPath.startsWith('/deliveries/')) {
        if (scenario.kind === 'invalid-schema') {
          sendBody(res, 200, scenario.body);
          return;
        }
        const id = decodeURIComponent(
          rawPath.slice('/deliveries/'.length),
        );
        const record = deliveries.get(id);
        if (record === undefined) {
          sendBody(res, 404, { error: 'unknown delivery' });
          return;
        }
        if (record.outcome === 'pending') {
          sendBody(res, 200, { status: 'pending' });
          return;
        }
        if (record.outcome === 'accepted') {
          sendBody(res, 200, {
            status: 'accepted',
            reference: record.reference,
          });
          return;
        }
        sendBody(res, 200, {
          status: 'rejected',
          message: 'No mailbox for recipient',
        });
        return;
      }
      sendBody(res, 404, { error: 'not found' });
    };

    const server = http.createServer((req, res) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent) {
          try {
            sendBody(res, 500, { error: 'harness failure' });
          } catch {
            // Connection already gone.
          }
        }
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('harness failed to bind an ephemeral port'));
        return;
      }
      const close = (): Promise<void> =>
        new Promise((resolveClose) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => {
            resolveClose();
          });
        });
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close,
      });
    });
  });
}
