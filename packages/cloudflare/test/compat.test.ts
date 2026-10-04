import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION, type CompatibilityDescriptor } from "@canlang/contracts";
import { checkCompatibility, type InstalledRuntime } from "../src/deploy/compat.js";

const descriptor: CompatibilityDescriptor = {
  identity: {
    appName: "TeamTasks",
    sourceRevision: "14fa6a0",
    languageVersion: "1.0.0",
    compilerVersion: "0.1.0",
    contractsVersion: CONTRACTS_VERSION,
    artifactDigest: "digest-fixture",
  },
  requiredCapabilities: ["d1-batch"],
  resourceBindings: [{ binding: "DB", kind: "d1", logicalName: "teamtasks-db" }],
  secrets: [{ binding: "MAIL_KEY", optional: false }],
  schedules: [],
};

const environment = {
  environment: "local",
  resources: [{ requirement: descriptor.resourceBindings[0]!, resourceId: "local-d1" }],
  secretsPresent: ["MAIL_KEY"],
  vars: {},
};

const installed: InstalledRuntime = {
  contractsVersion: CONTRACTS_VERSION,
  runtimeVersion: "test-runtime",
  capabilities: ["d1-batch"],
  knownLanguageVersions: ["1.0.0"],
  supportsSchedules: false,
};

describe("checkCompatibility", () => {
  it("accepts a fully satisfied descriptor", () => {
    expect(checkCompatibility(descriptor, environment, installed)).toEqual({ compatible: true });
  });

  it("rejects contracts-version skew", () => {
    const verdict = checkCompatibility(descriptor, environment, { ...installed, contractsVersion: 99 });
    expect(verdict).toEqual({
      compatible: false,
      reasons: [
        {
          code: "contracts-mismatch",
          detail: `artifact wants contracts v${CONTRACTS_VERSION}, installed v99`,
        },
      ],
    });
  });

  it("rejects unknown language versions", () => {
    const verdict = checkCompatibility(descriptor, environment, {
      ...installed,
      knownLanguageVersions: [],
    });
    expect(verdict.compatible).toBe(false);
    if (!verdict.compatible) {
      expect(verdict.reasons.map((reason) => reason.code)).toEqual(["unknown-language-version"]);
    }
  });

  it("lists every missing capability in descriptor order", () => {
    const verdict = checkCompatibility(
      { ...descriptor, requiredCapabilities: ["d1-batch", "do-alarms"] },
      environment,
      installed,
    );
    expect(verdict.compatible).toBe(false);
    if (!verdict.compatible) {
      expect(verdict.reasons).toEqual([{ code: "missing-capability", detail: "do-alarms" }]);
    }
  });

  it("rejects missing and mismatched bindings", () => {
    const missing = checkCompatibility(descriptor, { ...environment, resources: [] }, installed);
    expect(missing.compatible).toBe(false);

    const mismatched = checkCompatibility(
      descriptor,
      {
        ...environment,
        resources: [
          {
            requirement: { binding: "DB", kind: "r2", logicalName: "wrong" },
            resourceId: "x",
          },
        ],
      },
      installed,
    );
    expect(mismatched.compatible).toBe(false);
    if (!mismatched.compatible) {
      expect(mismatched.reasons[0]?.code).toBe("missing-binding");
    }
  });

  it("requires non-optional secrets but not optional ones", () => {
    const noSecrets = checkCompatibility(descriptor, { ...environment, secretsPresent: [] }, installed);
    expect(noSecrets.compatible).toBe(false);

    const optional = checkCompatibility(
      { ...descriptor, secrets: [{ binding: "MAYBE_KEY", optional: true }] },
      { ...environment, secretsPresent: [] },
      installed,
    );
    expect(optional).toEqual({ compatible: true });
  });

  it("rejects schedules without a schedule backend", () => {
    const verdict = checkCompatibility(
      { ...descriptor, schedules: [{ handler: "team.Remind", everyMilliseconds: "1000" }] },
      environment,
      installed,
    );
    expect(verdict.compatible).toBe(false);
    if (!verdict.compatible) {
      expect(verdict.reasons.map((reason) => reason.code)).toEqual(["unsupported-schedule"]);
    }
  });
});
