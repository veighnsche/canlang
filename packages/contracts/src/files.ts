/**
 * Lane 04 files contracts: upload intents, content transfer, finalization,
 * immutable provenance, retention and the v1 host bridge.
 *
 * Normative basis: DESIGN section 8 (files primitive, bridge v1, receiving
 * app finalization); DECISIONS attachment-handoff entry (Oct 4, 2026).
 *
 * Type-only boundary. Byte intake, content validation, storage and garbage
 * collection live in `@canlang/files`. Attachment authority and atomic
 * record references belong to lane 3.
 */

import type { DatetimeValue } from './values.js';

/**
 * This contract's version. Added by T13a alongside
 * `SERVICES_CONTRACT_VERSION`; T13a attachment backing
 * (`FinalizedFileRef`) is versioned by it.
 */
export const FILES_CONTRACT_VERSION = 1;

/**
 * Opaque immutable finalized file identity. Grants nothing by itself.
 *
 * T13a: element type of `EmailSendInput.attachments` (`services.ts`);
 * the committed outbox freezes attachment versions with the recipient
 * (DESIGN section 8). T27 image finalization is out of this slice.
 */
export type FinalizedFileRef = string;

/** Opaque upload-intent identity minted by the runtime. */
export type UploadIntentId = string;

/** Caller-generated stable retry identity, separate from `operation_id`. */
export type UploadRetryId = string;

/**
 * Effective file policy. The language-version-pinned baseline
 * (`application/pdf,image/png,image/jpeg,text/plain`, 10MiB) is defined in
 * DESIGN section 8; a `files` context declaration supplies only deviations.
 * Policy values never grant access.
 */
export interface FilePolicy {
  /** Accepted content types; actual bytes are validated, not MIME labels. */
  types: string[];
  /** Maximum accepted bytes per file. */
  maxBytes: number;
}

/**
 * Bridge v1 step 1 request: `POST /files/intents` (DESIGN section 8).
 * Lane 6 owns the route contract, so this name is the `wire.ts`
 * declaration, re-exported here for the bridge's signatures. Resolves
 * app/user/team and operation authority; business guards with
 * incomplete inputs stay unevaluated; never establishes acceptance.
 */
export type { UploadIntentRequest } from './wire.js';

/**
 * Bridge v1 step 1 response. Opaque intent identity plus generated
 * same-origin HTTPS destinations, never storage credentials.
 */
export interface UploadIntentGrant {
  intent_id: UploadIntentId;
  content: string;
  finalize: string;
  expires_at: string;
}

/**
 * Bridge v1 step 3 response. Repeating a completed intent returns the same
 * immutable reference; conflicting retry identity/context or replacement
 * bytes fail. Finalization creates no business record.
 */
export interface FinalizeResult {
  file: FinalizedFileRef;
}

/** Verdict of runtime content validation at intake/finalization. */
export type ContentVerdict = 'accepted' | 'rejected';

/**
 * Content check evidence. Supported formats are checked against actual
 * bytes; an incomplete or rejected transfer yields no usable file.
 */
export interface ContentCheck {
  claimedType: string;
  detectedType: string | null;
  sizeBytes: number;
  verdict: ContentVerdict;
}

/**
 * Provenance bound to a receiving-app finalized result (DESIGN section 8).
 * Request provenance binds receiving app/team/storage owner, verified
 * originating principal/source, adapter, delivery and result path.
 */
export interface RequestProvenance {
  kind: 'request';
  app: string;
  team: string;
  owner: string;
  principal: string;
  adapter: string;
  deliveryId: string;
  resultPath: string;
}

/**
 * Provenance for file fields in verified capability events, including
 * incoming email attachments: configured source/adapter, authenticated
 * event occurrence identity, schema field path and ordered item position.
 */
export interface EventProvenance {
  kind: 'event';
  source: string;
  adapter: string;
  occurrenceId: string;
  fieldPath: string;
  itemIndex: number;
}

/** Provenance bound at receiving-app finalization. */
export type FileProvenance = RequestProvenance | EventProvenance;

/**
 * Immutable finalized file record. Content is never overwritten; replacing
 * a reference never overwrites bytes. Timestamps are lane-2 datetime
 * values; wire encoding via L2 codecs.
 */
export interface FinalizedFile {
  id: FinalizedFileRef;
  provenance: FileProvenance;
  /** Validated content type of the immutable bytes. */
  contentType: string;
  sizeBytes: number;
  /** Digest of the immutable bytes for conflict detection. */
  bytesDigest: string;
  /** Lane-2 datetime value; wire encoding via L2 codecs. */
  finalizedAt: DatetimeValue;
}

/**
 * Stored-object lifecycle state. Partial uploads are unusable; completed
 * but unreferenced objects are garbage-collected after the receipt/
 * attachment horizon; retention redaction never recalls provider copies.
 */
export type StoredObjectState =
  | 'uploading'
  | 'finalized'
  | 'attached'
  | 'orphaned'
  | 'expired';

/**
 * MCP `_meta["org.canlang/fileTransfer"]` advertisement (DESIGN section 8).
 * Lane 6 owns the route contract, so this name is the `wire.ts`
 * declaration, re-exported here for the bridge's signatures. Metadata
 * grants no file access.
 */
export type { FileTransferMeta } from './wire.js';
