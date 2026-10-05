import type {
  CompatibilityDescriptor,
  CompatibilityFailure,
  CompatibilityVerdict,
  EnvironmentSelection,
} from "@canlang/contracts";
import { probeInstalledRuntime } from "./installed.js";

/**
 * What the deployment target actually runs. Capability-gated: versions select
 * known language releases, but behavior comes from capability presence.
 * `contractsVersion` is the caller's supported `@canlang/contracts` version
 * (pass `CONTRACTS_VERSION`); the check takes it as input so this module has
 * no runtime dependency on the contracts package.
 */
export interface InstalledRuntime {
  contractsVersion: number;
  runtimeVersion: string;
  capabilities: readonly string[];
  knownLanguageVersions: readonly string[];
  supportsSchedules: boolean;
}

/**
 * The one installed artifact/capability compatibility check. Pure: no I/O,
 * deterministic reason order (contracts, language, capabilities, bindings,
 * secrets, schedules). Fails closed on anything unknown or missing.
 */
export function checkCompatibility(
  descriptor: CompatibilityDescriptor,
  environment: EnvironmentSelection,
  installed: InstalledRuntime,
): CompatibilityVerdict {
  const reasons: CompatibilityFailure[] = [];

  if (descriptor.identity.contractsVersion !== installed.contractsVersion) {
    reasons.push({
      code: "contracts-mismatch",
      detail: `artifact wants contracts v${descriptor.identity.contractsVersion}, installed v${installed.contractsVersion}`,
    });
  }

  if (!installed.knownLanguageVersions.includes(descriptor.identity.languageVersion)) {
    reasons.push({
      code: "unknown-language-version",
      detail: `language ${descriptor.identity.languageVersion} is not installed`,
    });
  }

  for (const capability of descriptor.requiredCapabilities) {
    // Unknown IDs also land here until a capability registry distinguishes
    // "unknown" from "known but not installed"; both fail closed either way.
    if (!installed.capabilities.includes(capability)) {
      reasons.push({ code: "missing-capability", detail: capability });
    }
  }

  for (const requirement of descriptor.resourceBindings) {
    const resolved = environment.resources.find(
      (candidate) => candidate.requirement.binding === requirement.binding,
    );
    if (resolved === undefined) {
      reasons.push({
        code: "missing-binding",
        detail: `no resource selected for binding ${requirement.binding}`,
      });
    } else if (
      resolved.requirement.kind !== requirement.kind ||
      resolved.requirement.logicalName !== requirement.logicalName
    ) {
      reasons.push({
        code: "missing-binding",
        detail: `binding ${requirement.binding} resolves to a different requirement`,
      });
    }
  }

  for (const secret of descriptor.secrets) {
    if (!secret.optional && !environment.secretsPresent.includes(secret.binding)) {
      reasons.push({ code: "missing-secret", detail: secret.binding });
    }
  }

  if (descriptor.schedules.length > 0 && !installed.supportsSchedules) {
    reasons.push({
      code: "unsupported-schedule",
      detail: `${descriptor.schedules.length} schedule(s) but the target has no schedule backend`,
    });
  }

  return reasons.length === 0 ? { compatible: true } : { compatible: false, reasons };
}

/**
 * B5-J3: the deployment's target declaration as found in the tree
 * (`<stem>.target.json` next to the artifact). Same shape the installed
 * probe takes — this constructor adds no new vocabulary.
 */
export interface TreeTargetDeclaration {
  contractsVersion: number;
  runtimeVersion: string;
  knownLanguageVersions: readonly string[];
  capabilities: readonly string[];
  supportsSchedules: boolean;
}

/**
 * B5-J3: build the `InstalledRuntime` the gates check against from the
 * installed tree's target declaration. Thin additive wrapper over the
 * `installed.ts` probe (which validates unknown capability ids loud);
 * `env` is the real target env, threaded for the probe's future
 * binding cross-check join.
 */
export function installedFromTree(
  env: Record<string, unknown>,
  declaration: TreeTargetDeclaration,
): InstalledRuntime {
  return probeInstalledRuntime(env, declaration);
}

/** B5-J3: compiler-vs-runtime release comparison. No new failure codes. */
export type CompilerVersionCheck = { match: true } | { match: false; detail: string };

/**
 * B5-J3: compare the artifact's compiler release against the installed
 * runtime release. Under release lockstep both equal `RELEASE_VERSION`;
 * a mismatch means the artifact was built by a different release than
 * the target runs, and deploy refuses `--yes` (fail closed). Pure.
 */
export function checkCompilerVersionMatch(
  descriptor: CompatibilityDescriptor,
  installed: InstalledRuntime,
): CompilerVersionCheck {
  const want = descriptor.identity.compilerVersion;
  if (want === installed.runtimeVersion) return { match: true };
  return {
    match: false,
    detail:
      `artifact compiled by ${JSON.stringify(want)} but the target runs ` +
      `runtime ${JSON.stringify(installed.runtimeVersion)}`,
  };
}
