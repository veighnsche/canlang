import type {
  CompatibilityDescriptor,
  CompatibilityFailure,
  CompatibilityVerdict,
  EnvironmentSelection,
} from "@canlang/contracts";

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
