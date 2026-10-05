/**
 * Host bridge v1 (DESIGN section 8): same-principal/team intent auth,
 * MCP `_meta` advertisement, generated same-origin destinations, and the
 * unsupported-host fallback.
 *
 * Auth is typed principal resolution, not invented auth: the L7 worker
 * assembly resolves the L6 `ResolvedIdentity` caller to a receiving
 * identity through `PrincipalResolverPort`, and every byte/provenance
 * check downstream re-verifies the same principal/team. Grant
 * destinations are generated from the validated bridge origin only —
 * there is no parameter, header or metadata slot through which a model
 * could supply an endpoint or a credential, and grants never carry
 * storage credentials.
 *
 * Route shapes (`UploadIntentRequest`, `FileTransferMeta`) are lane-6
 * `wire.ts` declarations used directly: this bridge speaks the route
 * contract, and L7's interim barrel picks keep resolving through the
 * `files.ts` re-exports. The `_meta` key literal is pinned against
 * wire's by type (see below); full value convergence awaits the
 * `@canlang/contracts` workspace join.
 */
import type {
  FileTransferMeta,
  UploadIntentRequest,
} from '../../contracts/src/wire.js';
import type { UploadIntentId } from '../../contracts/src/files.js';
import type { PrincipalResolverPort } from './ports.ts';
import type {
  ReceivingContext,
  RequestProvenanceBinding,
} from './provenance/index.ts';
import type {
  FinalizeDeps,
  FinalizeOutcome,
} from './finalize/index.ts';
import { finalizeUpload } from './finalize/index.ts';
import type {
  AppendOutcome,
  CompleteOutcome,
  CreateIntentOutcome,
  UploadDeps,
} from './upload/index.ts';
import {
  appendUploadContent,
  completeUploadContent,
  createUploadIntent,
} from './upload/index.ts';

/**
 * MCP `_meta` key for the file-transfer advertisement (DESIGN §8).
 * Canonical value lives in lane-6 `wire.ts`; repeated here because
 * standalone TS-source tests cannot runtime-import contracts values
 * (`.js`-suffixed specifiers exist only as `.ts` — full value
 * convergence awaits the `@canlang/contracts` workspace join).
 * Literal pinned against wire's by the files contract-shapes test.
 */
export const FILE_TRANSFER_META_KEY = 'org.canlang/fileTransfer';

/** Validated same-origin HTTPS base. Construct via `createBridgeOrigin`. */
export interface BridgeOrigin {
  readonly baseUrl: string;
}

export interface BridgeDeps {
  readonly origin: BridgeOrigin;
  readonly principals: PrincipalResolverPort;
}

/** Host-declared file-transfer support for bridge routing. */
export interface HostCapabilities {
  readonly name: string;
  readonly fileTransferVersions: readonly number[];
}

export type BridgeRoute =
  | { readonly action: 'bridge-v1'; readonly meta: FileTransferMeta }
  | {
      readonly action: 'fallback';
      readonly reason: 'unsupported-host';
      readonly message: string;
    };

export type BridgeCreateOutcome =
  | CreateIntentOutcome
  | { readonly status: 'rejected'; readonly reason: 'unauthorized' };

export interface BridgeFinalizeInput {
  readonly intentId: string;
  readonly retryId: string;
  readonly bytesDigest: string;
}

/**
 * Validate a bridge origin: absolute HTTPS URL, no credentials, no
 * query/fragment, trailing slashes stripped. Returns null (fail closed)
 * for anything else, including model-shaped `http://` or embedded-token
 * URLs.
 */
export function createBridgeOrigin(baseUrl: string): BridgeOrigin | null {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') {
    return null;
  }
  if (url.username !== '' || url.password !== '') {
    return null;
  }
  if (url.search !== '' || url.hash !== '') {
    return null;
  }
  const normalized = url.toString().replace(/\/+$/, '');
  if (normalized.length === 0) {
    return null;
  }
  return { baseUrl: normalized };
}

/** Same-origin `POST /files/intents` URL for the selected app. */
export function intentsUrlFor(origin: BridgeOrigin): string {
  return `${origin.baseUrl}/files/intents`;
}

/**
 * MCP `_meta["org.canlang/fileTransfer"]` advertisement (version 1).
 * Metadata grants no file access.
 */
export function advertiseFileTransfer(origin: BridgeOrigin): FileTransferMeta {
  return { version: 1, intents: intentsUrlFor(origin) };
}

/**
 * Route a host to bridge v1 or the degraded fallback. Hosts without
 * fileTransfer v1 continue without byte upload; the fallback carries no
 * endpoint or credential and never fabricates one.
 */
export function routeHost(origin: BridgeOrigin, host: HostCapabilities): BridgeRoute {
  if (
    typeof host === 'object' &&
    host !== null &&
    Array.isArray(host.fileTransferVersions) &&
    host.fileTransferVersions.includes(1)
  ) {
    return { action: 'bridge-v1', meta: advertiseFileTransfer(origin) };
  }
  return {
    action: 'fallback',
    reason: 'unsupported-host',
    message: 'host does not support fileTransfer v1; continuing without byte upload',
  };
}

/**
 * Bridge v1 step 1 handler: resolve the caller to its receiving
 * identity, then mint the intent with destinations generated from the
 * bridge origin (which always wins over any configured base).
 * Unauthenticated callers are rejected before any intent exists.
 */
export function handleCreateIntent(
  bridge: BridgeDeps,
  files: UploadDeps,
  caller: unknown,
  request: UploadIntentRequest,
  binding: RequestProvenanceBinding,
): BridgeCreateOutcome {
  const receiver: ReceivingContext | null = bridge.principals.resolve(caller);
  if (receiver === null) {
    return { status: 'rejected', reason: 'unauthorized' };
  }
  return createUploadIntent(
    { ...files, urlBase: bridge.origin.baseUrl },
    { request, receiver, binding },
  );
}

/**
 * Bridge v1 step 2a handler: resolve the caller, then append under the
 * same-principal/team check. Unauthenticated callers share the `foreign`
 * outcome (no existence oracle).
 */
export function handleAppend(
  bridge: BridgeDeps,
  files: UploadDeps,
  caller: unknown,
  intentId: UploadIntentId,
  chunk: Uint8Array,
): AppendOutcome {
  const receiver: ReceivingContext | null = bridge.principals.resolve(caller);
  if (receiver === null) {
    return { status: 'failed', reason: 'foreign' };
  }
  return appendUploadContent(files, intentId, receiver, chunk);
}

/**
 * Bridge v1 step 2b handler: resolve the caller, then complete under the
 * same-principal/team check. Unauthenticated callers share the `foreign`
 * outcome (no existence oracle).
 */
export function handleComplete(
  bridge: BridgeDeps,
  files: UploadDeps,
  caller: unknown,
  intentId: UploadIntentId,
): CompleteOutcome {
  const receiver: ReceivingContext | null = bridge.principals.resolve(caller);
  if (receiver === null) {
    return { status: 'failed', reason: 'foreign' };
  }
  return completeUploadContent(files, intentId, receiver);
}

/**
 * Bridge v1 step 3 handler: resolve the caller, then finalize under the
 * same-principal/team check. Unauthenticated callers share the `foreign`
 * outcome (no existence oracle).
 */
export function handleFinalize(
  bridge: BridgeDeps,
  files: FinalizeDeps,
  caller: unknown,
  input: BridgeFinalizeInput,
): FinalizeOutcome {
  const receiver: ReceivingContext | null = bridge.principals.resolve(caller);
  if (receiver === null) {
    return { status: 'failed', reason: 'foreign' };
  }
  return finalizeUpload(files, {
    intentId: input.intentId,
    retryId: input.retryId,
    bytesDigest: input.bytesDigest,
    caller: receiver,
  });
}
