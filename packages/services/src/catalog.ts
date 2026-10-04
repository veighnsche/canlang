/**
 * Additive versioned adapter catalog for `@canlang/services`.
 *
 * Minimal shape only: owning package, catalog version, and one entry
 * per bound capability (capability name + version + supported
 * operations). No shared envelopes are invented here; completion and
 * receipt shapes stay in `@canlang/contracts`.
 */
export interface ServiceCatalogEntry {
  readonly capability: string;
  readonly capabilityVersion: number;
  readonly operations: readonly string[];
}

export interface ServiceCatalog {
  readonly package: string;
  readonly version: number;
  readonly entries: readonly ServiceCatalogEntry[];
}

export const SERVICES_CATALOG: ServiceCatalog = {
  package: '@canlang/services',
  version: 1,
  entries: [
    {
      capability: 'std.EmailV1',
      capabilityVersion: 1,
      operations: ['send'],
    },
  ],
};
