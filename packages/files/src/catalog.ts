/**
 * Additive versioned catalog entries owned by `@canlang/files`.
 *
 * Minimal `{package, version, entries[]}` shape only; the shared catalog
 * envelope (if any) is defined by the first L1/L2 contract join, not here
 * (implementation/CONTRACTS.md). Entries name file capabilities so
 * consumers can check feature availability at build/activation time.
 */
export interface FilesCatalogEntry {
  name: string;
  version: number;
}

export interface FilesCatalog {
  package: '@canlang/files';
  version: string;
  entries: FilesCatalogEntry[];
}

/** Mirrors the package version; the kernel performs no IO to read it. */
export const FILES_CATALOG_VERSION = '0.0.0';

export const filesCatalog: FilesCatalog = {
  package: '@canlang/files',
  version: FILES_CATALOG_VERSION,
  entries: [
    { name: 'upload.intent', version: 1 },
    { name: 'upload.content-append', version: 1 },
    { name: 'upload.content-complete', version: 1 },
    { name: 'upload.validation', version: 1 },
    { name: 'finalize.idempotent', version: 1 },
    { name: 'finalize.event-ingest', version: 1 },
    { name: 'finalize.provider-output', version: 1 },
    { name: 'finalize.provenance-read', version: 1 },
    { name: 'provenance.request-binding', version: 1 },
    { name: 'provenance.immutable', version: 1 },
    { name: 'retention.gc-horizon', version: 1 },
    { name: 'retention.redaction', version: 1 },
    { name: 'bridge.intent-auth', version: 1 },
    { name: 'bridge.content-auth', version: 1 },
    { name: 'bridge.meta-advertisement', version: 1 },
    { name: 'bridge.host-fallback', version: 1 },
    { name: 'storage.blob-port', version: 1 },
    { name: 'storage.fs-blobs', version: 1 },
  ],
};
