import { describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  DEPLOYMENT_CONTRACT_VERSION,
  type CompatibilityDescriptor,
  type CompatibilityVerdict,
  type EnvironmentSelection,
  type UpgradeState,
} from "../src/index";

const descriptor: CompatibilityDescriptor = {
  identity: {
    appName: "TeamTasks",
    sourceRevision: "b06d873",
    languageVersion: "1.0.0",
    compilerVersion: "0.1.0",
    contractsVersion: CONTRACTS_VERSION,
    artifactDigest: "digest-fixture",
  },
  requiredCapabilities: ["d1-batch"],
  resourceBindings: [{ binding: "DB", kind: "d1", logicalName: "teamtasks-db" }],
  secrets: [{ binding: "MAIL_KEY", optional: false }],
  schedules: [{ handler: "team.Remind", everyMilliseconds: "86400000" }],
};

describe("deployment contracts", () => {
  it("pins version constants at 1", () => {
    expect(CONTRACTS_VERSION).toBe(1);
    expect(DEPLOYMENT_CONTRACT_VERSION).toBe(1);
  });

  it("round-trips a compatibility descriptor through JSON", () => {
    const revived = JSON.parse(JSON.stringify(descriptor)) as CompatibilityDescriptor;
    expect(revived).toEqual(descriptor);
  });

  it("keeps schedule durations as JSON-safe decimal strings, never Numbers", () => {
    for (const schedule of descriptor.schedules) {
      expect(typeof schedule.everyMilliseconds).toBe("string");
      expect(schedule.everyMilliseconds).toMatch(/^\d+$/);
    }
  });

  it("carries secret names only, never values", () => {
    const selection: EnvironmentSelection = {
      environment: "local",
      resources: [
        {
          requirement: descriptor.resourceBindings[0]!,
          resourceId: "local-d1",
        },
      ],
      secretsPresent: ["MAIL_KEY"],
      vars: { LOCALE: "en" },
    };
    expect(JSON.stringify(selection)).not.toContain("secret-value");
    expect(selection.secretsPresent).toEqual(["MAIL_KEY"]);
  });

  it("reports incompatible verdicts with coded reasons", () => {
    const verdict: CompatibilityVerdict = {
      compatible: false,
      reasons: [{ code: "missing-secret", detail: "MAIL_KEY absent in local" }],
    };
    expect(verdict.compatible).toBe(false);
    if (!verdict.compatible) {
      expect(verdict.reasons).toHaveLength(1);
    }
  });

  it("requires failure detail exactly on failed upgrade stages", () => {
    const failed: UpgradeState = {
      stage: "staging-failed",
      plan: { from: [], to: descriptor.identity, pendingWork: [] },
      progress: { stagedOwners: 0, totalOwners: 1 },
      failure: { reason: "fixture", recoverable: true },
    };
    expect(failed.failure?.recoverable).toBe(true);
  });
});
