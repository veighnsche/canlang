/**
 * Additive versioned catalog entries owned by `@canlang/work`.
 *
 * Minimal `{package, version, entries[]}` shape only; the shared catalog
 * envelope (if any) is defined by the first L1/L2 contract join, not here
 * (implementation/CONTRACTS.md). Entries name kernel capabilities so
 * consumers can check feature availability at build/activation time.
 */
export interface WorkCatalogEntry {
  name: string;
  version: number;
}

export interface WorkCatalog {
  package: '@canlang/work';
  version: string;
  entries: WorkCatalogEntry[];
}

/** Mirrors the package version; the kernel performs no IO to read it. */
export const WORK_CATALOG_VERSION = '0.0.0';

export const workCatalog: WorkCatalog = {
  package: '@canlang/work',
  version: WORK_CATALOG_VERSION,
  entries: [
    { name: 'intent.outbox-id', version: 1 },
    { name: 'intent.frozen-request', version: 1 },
    { name: 'intent.commit-gate', version: 1 },
    { name: 'event.occurrence-admission', version: 1 },
    { name: 'event.committed-change', version: 1 },
    { name: 'schedule.keyed', version: 1 },
    { name: 'schedule.every', version: 1 },
    { name: 'dispatch.guard-claim', version: 1 },
    { name: 'receipt.outcome', version: 1 },
    { name: 'receipt.backoff', version: 1 },
    { name: 'receipt.reconcile', version: 1 },
    { name: 'recovery.inventory', version: 1 },
    { name: 'recovery.due-scan', version: 1 },
    { name: 'recovery.claim-expiry', version: 1 },
  ],
};
