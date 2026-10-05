/**
 * J6 real file-kernel binding: adapt injected L4 entry points to the
 * `FileKernel` port (plus the finalized-file journey extension).
 *
 * `@canlang/files` ships no built surface, so this module cannot import
 * it — not even as types. The bindings below are structural: the L7
 * worker assembly (deploy join) supplies the real L4 functions
 * (`createUploadIntent`, `appendUploadContent`, `completeUploadContent`,
 * `finalizeUpload` over live deps) already bound to their deps, and this
 * adapter only validates the seams and promisifies the calls. L4's
 * kernel is sync but durable stores behind it are async, so every port
 * method is async and sync-or-async L4 functions are both accepted.
 *
 * Fail-loud contract: every seam is validated up front. A missing,
 * non-function, or otherwise unusable entry point throws naming the
 * seam — the adapter never substitutes a fake kernel, invents bytes, or
 * silently skips a step. Kernel outcomes pass through verbatim (L4 is
 * typed; this layer re-validates nothing).
 *
 * The journey extension (`FileJourneyKernel`) carries the post-finalize
 * steps — provenance read, attach pre-check, lane-3 attachment
 * recording, finalized-byte reads — over the same binding table so one
 * bound kernel serves the whole
 * intent -> bytes -> finalize -> provenance -> attach/read path.
 * Attachment authority stays with lane 3 (`recordAttachment` is its
 * join seam); this adapter only threads the call.
 */
import type {
  FinalizedFile,
  UploadIntentRequest,
} from '@canlang/contracts';
import type {
  FileKernel,
  KernelAppendOutcome,
  KernelCompleteOutcome,
  KernelCreateOutcome,
  KernelFinalizeOutcome,
  UploadBinding,
  UploadReceiver,
} from '../ports.js';

/** Structural L4 `createUploadIntent` input (upload/index.ts). */
export interface KernelCreateInput {
  readonly request: UploadIntentRequest;
  readonly receiver: UploadReceiver;
  readonly binding: UploadBinding;
}

/** Structural L4 `finalizeUpload` input (finalize/index.ts). */
export interface KernelFinalizeInput {
  readonly intentId: string;
  readonly retryId: string;
  readonly bytesDigest: string;
  readonly caller: UploadReceiver;
}

/**
 * Injected L4 entry-point table for the `FileKernel` core. Each function
 * is the real L4 entry point already bound to its deps (upload/finalize
 * deps with live stores); `maxBytes` is the L4 effective per-transfer
 * byte ceiling (the policy owns the value).
 */
export interface FilesKernelBindings {
  readonly maxBytes: number;
  readonly createIntent: (
    input: KernelCreateInput,
  ) => KernelCreateOutcome | Promise<KernelCreateOutcome>;
  readonly append: (
    intentId: string,
    caller: UploadReceiver,
    chunk: Uint8Array,
  ) => KernelAppendOutcome | Promise<KernelAppendOutcome>;
  readonly complete: (
    intentId: string,
    caller: UploadReceiver,
  ) => KernelCompleteOutcome | Promise<KernelCompleteOutcome>;
  readonly finalize: (
    input: KernelFinalizeInput,
  ) => KernelFinalizeOutcome | Promise<KernelFinalizeOutcome>;
}

/** Mirror of L4 `AttachOutcome` (finalize/index.ts). */
export type KernelAttachOutcome =
  | { readonly status: 'authorized'; readonly ref: string }
  | { readonly status: 'failed'; readonly reason: 'foreign' | 'expired' };

/** Mirror of L4 `RecordAttachmentOutcome` (finalize/index.ts). */
export type KernelRecordAttachmentOutcome =
  | { readonly status: 'attached'; readonly ref: string }
  | { readonly status: 'failed'; readonly reason: 'foreign' | 'expired' };

/**
 * Injected L4 entry-point table for the full journey: the `FileKernel`
 * core plus provenance/attach/read (`readFinalizedFile`,
 * `authorizeAttach`, `recordAttachment`, `readFinalizedBytes`).
 */
export interface FileJourneyBindings extends FilesKernelBindings {
  readonly readProvenance: (
    ref: string,
    caller: UploadReceiver,
  ) => FinalizedFile | null | Promise<FinalizedFile | null>;
  readonly authorizeAttach: (
    ref: string,
    caller: UploadReceiver,
  ) => KernelAttachOutcome | Promise<KernelAttachOutcome>;
  readonly recordAttachment: (
    ref: string,
    recordRef: string,
    caller: UploadReceiver,
  ) => KernelRecordAttachmentOutcome | Promise<KernelRecordAttachmentOutcome>;
  readonly readBytes: (
    ref: string,
    caller: UploadReceiver,
  ) => Uint8Array | null | Promise<Uint8Array | null>;
}

/** `FileKernel` plus the post-finalize journey steps. */
export interface FileJourneyKernel extends FileKernel {
  /** Frozen finalized record, or null for every denial (fail closed). */
  readProvenance(ref: string, caller: UploadReceiver): Promise<FinalizedFile | null>;
  /** Pure attach pre-check: existence, bytes, ownership. */
  authorizeAttach(ref: string, caller: UploadReceiver): Promise<KernelAttachOutcome>;
  /** Lane-3 attachment recording (last-write-wins re-marks). */
  recordAttachment(
    ref: string,
    recordRef: string,
    caller: UploadReceiver,
  ): Promise<KernelRecordAttachmentOutcome>;
  /** Finalized bytes, or null for every denial (fail closed). */
  readBytes(ref: string, caller: UploadReceiver): Promise<Uint8Array | null>;
}

const CORE_SEAMS = ['createIntent', 'append', 'complete', 'finalize'] as const;
const JOURNEY_SEAMS = [
  'readProvenance',
  'authorizeAttach',
  'recordAttachment',
  'readBytes',
] as const;

function asTable(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      'uploads kernel: bindings are not configured (expected the L4 entry-point table); ' +
        'file upload cannot run until the L7 deploy join binds the real kernel',
    );
  }
  return value as Record<string, unknown>;
}

function requireSeam(table: Record<string, unknown>, name: string): void {
  if (typeof table[name] !== 'function') {
    throw new Error(
      `uploads kernel: '${name}' is not bound (the L7 deploy join supplies the real L4 entry point); ` +
        'file upload cannot run without it',
    );
  }
}

/**
 * Validate the core binding table. Throws naming the first unmet seam:
 * a missing/non-function entry point, or a `maxBytes` that is not a
 * usable byte ceiling.
 */
export function assertFileKernelBindings(value: unknown): asserts value is FilesKernelBindings {
  const table = asTable(value);
  for (const name of CORE_SEAMS) {
    requireSeam(table, name);
  }
  const maxBytes: unknown = table['maxBytes'];
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(
      'uploads kernel: \'maxBytes\' is not a usable byte ceiling ' +
        '(expected a non-negative safe integer from the L4 policy); ' +
        'file upload cannot run without it',
    );
  }
}

/** Validate the full journey binding table (core + journey seams). */
export function assertFileJourneyBindings(value: unknown): asserts value is FileJourneyBindings {
  assertFileKernelBindings(value);
  const table = value as unknown as Record<string, unknown>;
  for (const name of JOURNEY_SEAMS) {
    requireSeam(table, name);
  }
}

/**
 * Bind the real L4 entry points as a `FileKernel`. Throws on the first
 * unmet seam (see `assertFileKernelBindings`).
 */
export function createFileKernel(bindings: unknown): FileKernel {
  assertFileKernelBindings(bindings);
  return {
    maxBytes: () => bindings.maxBytes,
    createIntent: async (input) => bindings.createIntent(input),
    append: async (intentId, caller, chunk) => bindings.append(intentId, caller, chunk),
    complete: async (intentId, caller) => bindings.complete(intentId, caller),
    finalize: async (input) => bindings.finalize(input),
  };
}

/**
 * Bind the real L4 entry points as a `FileJourneyKernel`: the
 * `FileKernel` core plus provenance/attach/read. Throws on the first
 * unmet seam (see `assertFileJourneyBindings`).
 */
export function createFileJourneyKernel(bindings: unknown): FileJourneyKernel {
  assertFileJourneyBindings(bindings);
  const core = createFileKernel(bindings);
  return {
    ...core,
    readProvenance: async (ref, caller) => bindings.readProvenance(ref, caller),
    authorizeAttach: async (ref, caller) => bindings.authorizeAttach(ref, caller),
    recordAttachment: async (ref, recordRef, caller) =>
      bindings.recordAttachment(ref, recordRef, caller),
    readBytes: async (ref, caller) => bindings.readBytes(ref, caller),
  };
}
