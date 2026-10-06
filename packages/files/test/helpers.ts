/**
 * Shared S5 test harness: TEST-ONLY doubles wired into upload/finalize/
 * retention/bridge deps, plus byte fixtures. Not a test file itself
 * (the runner only discovers `*.test.ts`).
 */
import type {
  FilePolicy,
  UploadIntentRequest,
} from '@canlang/contracts';
import {
  TestOnlyCounterFileIds,
  TestOnlyCounterIntentIds,
  TestOnlyFixedPrincipal,
  TestOnlyManualClock,
  TestOnlyMemoryBlobStore,
  TestOnlyMemoryFinalizedStore,
  TestOnlyMemoryIntentStore,
  type BlobStorePort,
  type ClockPort,
  type FinalizedStorePort,
  type IntentStorePort,
} from '../src/ports.js';
import type {
  ReceivingContext,
  RequestProvenanceBinding,
} from '../src/provenance/index.js';
import type { FinalizeDeps } from '../src/finalize/index.js';
import { DEFAULT_FILE_POLICY, type UploadDeps } from '../src/upload/index.js';
import { createBridgeOrigin, type BridgeDeps } from '../src/bridge.js';
import type { RetentionDeps } from '../src/retention/index.js';

export const T0 = Date.parse('2026-10-04T15:00:00Z');
export const ORIGIN_URL = 'https://app.example.test';
export const INTENT_TTL_MS = 15 * 60 * 1000;

export const RECEIVER: ReceivingContext = {
  app: 'CanExpense',
  team: 'team_1',
  owner: 'team_1',
  principal: 'user_1',
};

export const OTHER_PRINCIPAL: ReceivingContext = {
  app: 'CanExpense',
  team: 'team_1',
  owner: 'team_1',
  principal: 'user_2',
};

export const OTHER_TEAM: ReceivingContext = {
  app: 'CanExpense',
  team: 'team_2',
  owner: 'team_2',
  principal: 'user_9',
};

export const BINDING: RequestProvenanceBinding = {
  adapter: 'deployment.web',
  deliveryId: 'del_1',
  resultPath: 'receipt',
};

export const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\ntrailer\n');
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
export const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
export const TEXT_BYTES = new TextEncoder().encode('hello, can\n');
export const GARBAGE_BYTES = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
export const TRUNCATED_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let uploadCounter = 0;

export function uploadRequest(
  overrides?: Partial<UploadIntentRequest> & { arguments?: Record<string, unknown> },
): UploadIntentRequest {
  uploadCounter += 1;
  return {
    upload_id: `upl_${uploadCounter}`,
    operation: 'expense.Expense.create',
    field: '/receipt',
    arguments: {},
    name: 'receipt.pdf',
    type: 'application/pdf',
    size: String(PDF_BYTES.length),
    ...overrides,
  };
}

export interface FileHarness {
  readonly clock: TestOnlyManualClock;
  readonly intents: IntentStorePort;
  readonly files: FinalizedStorePort;
  readonly blobs: BlobStorePort;
  readonly upload: UploadDeps;
  readonly finalize: FinalizeDeps;
  readonly retention: RetentionDeps;
  readonly bridge: BridgeDeps;
}

export function makeHarness(
  options?: {
    readonly policy?: FilePolicy;
    readonly blobs?: BlobStorePort;
    readonly intentTtlMs?: number;
    readonly receiver?: ReceivingContext | null;
  },
): FileHarness {
  const clock = new TestOnlyManualClock(T0);
  const intents = new TestOnlyMemoryIntentStore();
  const files = new TestOnlyMemoryFinalizedStore();
  const blobs = options?.blobs ?? new TestOnlyMemoryBlobStore();
  const policy = options?.policy ?? DEFAULT_FILE_POLICY;
  const intentTtlMs = options?.intentTtlMs ?? INTENT_TTL_MS;
  const upload: UploadDeps = {
    clock,
    intentIds: new TestOnlyCounterIntentIds(),
    intents,
    blobs,
    policy,
    intentTtlMs,
    urlBase: ORIGIN_URL,
  };
  const finalize: FinalizeDeps = {
    clock,
    fileIds: new TestOnlyCounterFileIds(),
    intents,
    blobs,
    files,
  };
  const retention: RetentionDeps = { clock, blobs, files, intents };
  const origin = createBridgeOrigin(ORIGIN_URL);
  if (origin === null) {
    throw new Error('test harness: fixed origin must validate');
  }
  const receiver = options?.receiver === undefined ? RECEIVER : options.receiver;
  const bridge: BridgeDeps = {
    origin,
    principals: new TestOnlyFixedPrincipal(receiver),
  };
  return { clock, intents, files, blobs, upload, finalize, retention, bridge };
}

export type { ClockPort };
