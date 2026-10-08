/**
 * B3-I6 installed-runtime probe: build the `InstalledRuntime` struct the
 * activation gates check against, from the real deployment target.
 *
 * Two vocabularies meet here. `KNOWN_CAPABILITIES` is the registry of
 * capability ids this lane understands: the compiler-emitted `requires`
 * producer ids (`canlang.builtins`, `values.*`, `state` — see
 * `compute_requires` in `compiler/src/codegen/artifact.rs`) plus the
 * infrastructure ids producers advertise (`d1-batch`, `do-alarms`, ...).
 * Additions are additive and reviewable; nothing else in this lane may
 * invent a capability id.
 *
 * The known-vs-installed split (`splitCapabilities`) is what lets the
 * activation gates tell "no producer defines this id" (`unknown`)
 * from "a producer defines it but this target does not install it"
 * (`missing`). Both fail closed; the split only sharpens the reason.
 */

import type { InstalledRuntime } from "./compat.js";

/**
 * Every capability id this lane knows. Producer ids mirror the
 * compiler's `requires` emission exactly; infra ids mirror the
 * deployment contract's vocabulary (`contracts/src/deployment.ts`).
 */
export const KNOWN_CAPABILITIES: readonly string[] = [
  "canlang.builtins",
  "values.decimal",
  "values.int64",
  "values.money",
  "values.temporal",
  "state",
  "state.machines",
  "state.parameters",
  "state.cohorts",
  "interfaces.input-choices",
  "d1-batch",
  "do-alarms",
];

/**
 * Known-vs-installed split. Order-preserving within each bucket
 * (candidate order first, then installed-only ids for `unknown`).
 */
export interface CapabilitySplit {
  /** Candidate ids that are known and installed. */
  installed: string[];
  /** Candidate ids that are known but not installed. */
  missing: string[];
  /** Ids on EITHER side outside the registry: fail closed. */
  unknown: string[];
}

/**
 * Split `candidate` ids against the known registry and the installed
 * set. `unknown` covers both sides (a target advertising an unknown id
 * is as fail-closed as requiring one); known installed ids no
 * candidate requires appear in no bucket. Pure and deterministic.
 */
export function splitCapabilities(
  candidate: readonly string[],
  installed: readonly string[],
): CapabilitySplit {
  const known = new Set(KNOWN_CAPABILITIES);
  const have = new Set(installed);
  const split: CapabilitySplit = { installed: [], missing: [], unknown: [] };
  for (const id of candidate) {
    if (!known.has(id)) {
      split.unknown.push(id);
    } else if (have.has(id)) {
      split.installed.push(id);
    } else {
      split.missing.push(id);
    }
  }
  const seen = new Set(candidate);
  for (const id of installed) {
    if (!seen.has(id)) {
      seen.add(id);
      if (!known.has(id)) {
        split.unknown.push(id);
      }
    }
  }
  return split;
}

/**
 * Deployment-declared target facts. Every field is required: the target
 * exposes no machine-readable capability signals today (verified: no
 * `CAN_*`/capability convention exists on the worker env), so the
 * deployment declares and the probe validates — never invents.
 */
export interface ProbeInstalledRuntimeOptions {
  /**
   * Caller's supported `@canlang/contracts` version (pass
   * `CONTRACTS_VERSION`); taken as input so this module keeps no
   * runtime dependency on the contracts package (mirrors `compat.ts`).
   */
  contractsVersion: number;
  runtimeVersion: string;
  knownLanguageVersions: readonly string[];
  capabilities: readonly string[];
  supportsSchedules: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the `InstalledRuntime` struct for `env` from the deployment's
 * target declaration.
 *
 * `env` is the real target env. It is threaded (and validated as a
 * record) for the binding cross-check join: when the vocabulary owner
 * defines binding-implies-capability rules, the probe verifies the
 * declaration against the env here. Until then the probe validates the
 * declaration only — unknown capability ids throw a plain `Error`
 * (deployment misconfiguration is a programmer bug, never a verdict).
 */
export function probeInstalledRuntime(
  env: Record<string, unknown>,
  opts: ProbeInstalledRuntimeOptions,
): InstalledRuntime {
  if (!isRecord(env)) {
    throw new TypeError("probeInstalledRuntime needs the target env as a record");
  }
  const split = splitCapabilities(opts.capabilities, opts.capabilities);
  if (split.unknown.length > 0) {
    throw new Error(
      `probeInstalledRuntime: unknown capability id(s) ${split.unknown.map((id) => JSON.stringify(id)).join(", ")} ` +
        `(known: ${KNOWN_CAPABILITIES.join(", ")})`,
    );
  }
  return {
    contractsVersion: opts.contractsVersion,
    runtimeVersion: opts.runtimeVersion,
    capabilities: [...opts.capabilities],
    knownLanguageVersions: [...opts.knownLanguageVersions],
    supportsSchedules: opts.supportsSchedules,
  };
}
