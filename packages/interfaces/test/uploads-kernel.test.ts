/**
 * J6 kernel-binding tests: the real-L4 adapter (`uploads/kernel.ts`)
 * passes outcomes through verbatim, accepts sync-or-async entry points,
 * and fails loud naming the first unmet seam. The scripted bindings are
 * L4-shaped plain functions (structural injection — this package cannot
 * import `@canlang/files`); the real kernel behind the real routes is
 * proven by the worker-assembly journey suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ContentCheck,
  FinalizedFile,
  UploadIntentGrant,
  UploadIntentRequest,
} from '@canlang/contracts';
import type {
  KernelAppendOutcome,
  KernelCompleteOutcome,
  KernelCreateOutcome,
  KernelFinalizeOutcome,
  UploadBinding,
  UploadReceiver,
} from '../src/ports.js';
import {
  createFileJourneyKernel,
  createFileKernel,
  type FileJourneyBindings,
  type FilesKernelBindings,
  type KernelAttachOutcome,
  type KernelRecordAttachmentOutcome,
} from '../src/uploads/kernel.js';

const RECEIVER: UploadReceiver = {
  app: 'test-app',
  team: 't-1',
  owner: 't-1',
  principal: 'u-1',
};

const BINDING: UploadBinding = {
  adapter: 'bridge-v1',
  deliveryId: 'up-1',
  resultPath: '/attachment',
};

const REQUEST: UploadIntentRequest = {
  upload_id: 'up-1',
  operation: 'shop.Order.create',
  field: '/attachment',
  arguments: {},
  name: 'a.pdf',
  type: 'application/pdf',
  size: '4',
};

const GRANT: UploadIntentGrant = {
  intent_id: 'intent-1',
  content: 'https://test.invalid/files/content/intent-1',
  finalize: 'https://test.invalid/files/finalize/intent-1',
  expires_at: '2026-10-04T16:00:00.000Z',
};

const CHECK: ContentCheck = {
  claimedType: 'application/pdf',
  detectedType: 'application/pdf',
  sizeBytes: 4,
  verdict: 'accepted',
};

const FILE: FinalizedFile = {
  id: 'file-1',
  provenance: {
    kind: 'request',
    app: 'test-app',
    team: 't-1',
    owner: 't-1',
    principal: 'u-1',
    adapter: 'bridge-v1',
    deliveryId: 'up-1',
    resultPath: '/attachment',
  },
  contentType: 'application/pdf',
  sizeBytes: 4,
  bytesDigest: 'sha256:deadbeef',
  finalizedAt: { kind: 'datetime', ms: BigInt(Date.parse('2026-10-04T16:00:00.000Z')) },
};

function coreBindings(overrides: Partial<FilesKernelBindings> = {}): FilesKernelBindings {
  return {
    maxBytes: 1024,
    createIntent: () => ({ status: 'granted', grant: GRANT, intentId: 'intent-1' }),
    append: () => ({ status: 'appended', receivedBytes: 4 }),
    complete: () => ({ status: 'completed', check: CHECK }),
    finalize: () => ({ status: 'finalized', result: { file: 'file-1' }, file: FILE }),
    ...overrides,
  };
}

function journeyBindings(overrides: Partial<FileJourneyBindings> = {}): FileJourneyBindings {
  return {
    ...coreBindings(),
    readProvenance: () => FILE,
    authorizeAttach: () => ({ status: 'authorized', ref: 'file-1' }),
    recordAttachment: () => ({ status: 'attached', ref: 'file-1' }),
    readBytes: () => new Uint8Array([1, 2, 3, 4]),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Core pass-through.                                                  */
/* ------------------------------------------------------------------ */

test('core kernel passes every outcome through verbatim', async () => {
  const kernel = createFileKernel(coreBindings());
  assert.equal(await kernel.maxBytes(), 1024);
  const created: KernelCreateOutcome = await kernel.createIntent({
    request: REQUEST,
    receiver: RECEIVER,
    binding: BINDING,
  });
  assert.deepEqual(created, { status: 'granted', grant: GRANT, intentId: 'intent-1' });
  const appended: KernelAppendOutcome = await kernel.append('intent-1', RECEIVER, new Uint8Array(4));
  assert.deepEqual(appended, { status: 'appended', receivedBytes: 4 });
  const completed: KernelCompleteOutcome = await kernel.complete('intent-1', RECEIVER);
  assert.deepEqual(completed, { status: 'completed', check: CHECK });
  const finalized: KernelFinalizeOutcome = await kernel.finalize({
    intentId: 'intent-1',
    retryId: 'up-1',
    bytesDigest: 'sha256:deadbeef',
    caller: RECEIVER,
  });
  assert.deepEqual(finalized, {
    status: 'finalized',
    result: { file: 'file-1' },
    file: FILE,
  });
});

test('core kernel accepts async L4 entry points', async () => {
  const kernel = createFileKernel(
    coreBindings({
      createIntent: async () => ({ status: 'duplicate', grant: GRANT, intentId: 'intent-1' }),
      append: async () => ({ status: 'failed', reason: 'closed' }),
      complete: async () => ({ status: 'failed', reason: 'partial' }),
      finalize: async () => ({ status: 'failed', reason: 'conflict' }),
    }),
  );
  assert.deepEqual(await kernel.createIntent({ request: REQUEST, receiver: RECEIVER, binding: BINDING }), {
    status: 'duplicate',
    grant: GRANT,
    intentId: 'intent-1',
  });
  assert.deepEqual(await kernel.append('intent-1', RECEIVER, new Uint8Array(1)), {
    status: 'failed',
    reason: 'closed',
  });
  assert.deepEqual(await kernel.complete('intent-1', RECEIVER), {
    status: 'failed',
    reason: 'partial',
  });
  assert.deepEqual(
    await kernel.finalize({ intentId: 'intent-1', retryId: 'up-1', bytesDigest: 'sha256:x', caller: RECEIVER }),
    { status: 'failed', reason: 'conflict' },
  );
});

test('kernel methods are async even over sync L4 functions', async () => {
  const kernel = createFileKernel(coreBindings());
  assert.ok((kernel.createIntent({ request: REQUEST, receiver: RECEIVER, binding: BINDING }) as unknown) instanceof Promise);
  assert.ok((kernel.append('intent-1', RECEIVER, new Uint8Array(0)) as unknown) instanceof Promise);
  assert.ok((kernel.complete('intent-1', RECEIVER) as unknown) instanceof Promise);
  assert.ok(
    (kernel.finalize({ intentId: 'i', retryId: 'r', bytesDigest: 'd', caller: RECEIVER }) as unknown) instanceof Promise,
  );
  const journey = createFileJourneyKernel(journeyBindings());
  assert.ok((journey.readProvenance('file-1', RECEIVER) as unknown) instanceof Promise);
  assert.ok((journey.readBytes('file-1', RECEIVER) as unknown) instanceof Promise);
});

/* ------------------------------------------------------------------ */
/* Core fail-loud seams.                                               */
/* ------------------------------------------------------------------ */

test('core kernel throws naming a missing table', () => {
  for (const bindings of [undefined, null, 42, 'kernel']) {
    assert.throws(() => createFileKernel(bindings), /bindings are not configured/);
  }
});

test('core kernel throws naming each unbound entry point', () => {
  for (const seam of ['createIntent', 'append', 'complete', 'finalize'] as const) {
    const bindings = { ...coreBindings(), [seam]: undefined };
    assert.throws(() => createFileKernel(bindings), new RegExp(`'${seam}' is not bound`), seam);
    const nonFunction = { ...coreBindings(), [seam]: 42 };
    assert.throws(() => createFileKernel(nonFunction), new RegExp(`'${seam}' is not bound`), seam);
  }
});

test('core kernel throws naming an unusable maxBytes', () => {
  for (const maxBytes of [undefined, null, '1024', Number.NaN, -1, 1.5]) {
    const bindings = { ...coreBindings(), maxBytes: maxBytes as unknown as number };
    assert.throws(() => createFileKernel(bindings), /'maxBytes' is not a usable byte ceiling/);
  }
  // Zero is usable (reject-everything policy still binds honestly).
  assert.equal(createFileKernel(coreBindings({ maxBytes: 0 })).maxBytes(), 0);
});

/* ------------------------------------------------------------------ */
/* Journey extension.                                                  */
/* ------------------------------------------------------------------ */

test('journey kernel passes provenance/attach/read through verbatim', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const kernel = createFileJourneyKernel(journeyBindings({ readBytes: () => bytes }));
  assert.equal(await kernel.readProvenance('file-1', RECEIVER), FILE);
  const authorized: KernelAttachOutcome = await kernel.authorizeAttach('file-1', RECEIVER);
  assert.deepEqual(authorized, { status: 'authorized', ref: 'file-1' });
  const attached: KernelRecordAttachmentOutcome = await kernel.recordAttachment(
    'file-1',
    'Expense_1',
    RECEIVER,
  );
  assert.deepEqual(attached, { status: 'attached', ref: 'file-1' });
  assert.deepEqual(await kernel.readBytes('file-1', RECEIVER), bytes);
  // The core still serves through the journey kernel.
  assert.deepEqual(await kernel.complete('intent-1', RECEIVER), {
    status: 'completed',
    check: CHECK,
  });
});

test('journey kernel passes fail-closed nulls through without substituting bytes', async () => {
  const kernel = createFileJourneyKernel(
    journeyBindings({
      readProvenance: () => null,
      authorizeAttach: () => ({ status: 'failed', reason: 'foreign' }),
      readBytes: () => null,
    }),
  );
  assert.equal(await kernel.readProvenance('file-9', RECEIVER), null);
  assert.deepEqual(await kernel.authorizeAttach('file-9', RECEIVER), {
    status: 'failed',
    reason: 'foreign',
  });
  assert.equal(await kernel.readBytes('file-9', RECEIVER), null);
});

test('journey kernel throws naming each unbound journey seam', () => {
  for (const seam of ['readProvenance', 'authorizeAttach', 'recordAttachment', 'readBytes'] as const) {
    const bindings = { ...journeyBindings(), [seam]: undefined };
    assert.throws(() => createFileJourneyKernel(bindings), new RegExp(`'${seam}' is not bound`), seam);
  }
});

test('journey kernel still validates the core seams', () => {
  const bindings = { ...journeyBindings(), finalize: undefined };
  assert.throws(() => createFileJourneyKernel(bindings), /'finalize' is not bound/);
});
