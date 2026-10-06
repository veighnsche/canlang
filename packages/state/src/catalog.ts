import { STATE_CONTRACT_VERSION } from '@canlang/contracts';

/** Internal engine version; released artifacts record this alongside output. */
export const STATE_ENGINE_VERSION = '0.1.0';

/**
 * Versioned machine-readable entry manifest for the state engine.
 * S1 carries identity only; later slices append owned entries (invocation,
 * query, mutation, storage, migration) as they land with real behavior.
 */
export interface StateCatalog {
  readonly name: '@canlang/state';
  readonly version: string;
  readonly contractVersion: number;
  readonly entries: ReadonlyArray<string>;
}

export function stateCatalog(): StateCatalog {
  return {
    name: '@canlang/state',
    version: STATE_ENGINE_VERSION,
    contractVersion: STATE_CONTRACT_VERSION,
    entries: [],
  };
}
