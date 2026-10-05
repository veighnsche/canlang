import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION, type CompatibilityDescriptor } from "@canlang/contracts";
import { buildDeployPlan, type DeployPlan } from "../src/deploy/plan.js";
import { renderDeployPlan } from "../src/deploy/render.js";
import { diffPlans, formatPreview, loadPreviousPlan, requireYes } from "../src/deploy/review.js";
import { applyUpgrade } from "../src/upgrade/apply.js";

const descriptor: CompatibilityDescriptor = {
  identity: {
    appName: "TeamTasks",
    sourceRevision: "14fa6a0",
    languageVersion: "1.0.0",
    compilerVersion: "0.1.0",
    contractsVersion: CONTRACTS_VERSION,
    artifactDigest: "digest-fixture",
  },
  requiredCapabilities: [],
  resourceBindings: [{ binding: "DB", kind: "d1", logicalName: "teamtasks-db" }],
  secrets: [],
  schedules: [],
};

const environment = {
  environment: "prod",
  resources: [
    {
      requirement: { binding: "DB", kind: "d1", logicalName: "teamtasks-db" },
      resourceId: "db-123",
    },
  ],
  secretsPresent: [],
  vars: { API_URL: "https://api.example.com" },
} as const;

const options = {
  workerName: "teamtasks",
  main: "./dist/worker/entry.js",
  compatibilityDate: "2026-10-04",
};

function plan(): DeployPlan {
  return buildDeployPlan(descriptor, environment, options);
}

describe("deploy render (B5-J3)", () => {
  it("renders deterministic wrangler.toml + JSON", () => {
    const first = renderDeployPlan(plan());
    const second = renderDeployPlan(plan());
    expect(second).toEqual(first);
    expect(first.toml).toContain('name = "teamtasks"');
    expect(first.toml).toContain('main = "./dist/worker/entry.js"');
    expect(first.toml).toContain('compatibility_date = "2026-10-04"');
    expect(first.toml).toContain("[[d1_databases]]");
    expect(first.toml).toContain('binding = "DB"');
    expect(JSON.parse(first.json)).toEqual(JSON.parse(JSON.stringify(plan())));
  });

  it("never invents cron: schedules render as an OPEN-139 comment only", () => {
    const scheduled = buildDeployPlan(
      {
        ...descriptor,
        schedules: [{ handler: "nightly", everyMilliseconds: "86400000" }],
      },
      environment,
      options,
    );
    const rendered = renderDeployPlan(scheduled);
    expect(rendered.toml).toContain("OPEN-139");
    expect(rendered.toml).not.toContain("86400000");
    expect(rendered.toml).not.toContain("cron");
  });
});

describe("deploy review (B5-J3)", () => {
  it("no previous plan: everything added, changed", () => {
    const diff = diffPlans(null, plan());
    expect(diff.changed).toBe(true);
    expect(diff.lines.length).toBeGreaterThan(0);
    expect(diff.lines.every((line) => line.startsWith("+"))).toBe(true);
  });

  it("identical plan: no changes", () => {
    expect(diffPlans(plan(), plan())).toEqual({ changed: false, lines: [] });
  });

  it("changed var: single ~ line naming both values", () => {
    const next = buildDeployPlan(
      descriptor,
      { ...environment, vars: { API_URL: "https://new.example.com" } },
      options,
    );
    const diff = diffPlans(plan(), next);
    expect(diff.changed).toBe(true);
    expect(diff.lines).toHaveLength(1);
    expect(diff.lines[0]).toContain("API_URL");
    expect(diff.lines[0]).toContain("https://api.example.com");
    expect(diff.lines[0]).toContain("https://new.example.com");
  });

  it("added binding: + line", () => {
    const next = buildDeployPlan(
      {
        ...descriptor,
        resourceBindings: [
          ...descriptor.resourceBindings,
          { binding: "FILES", kind: "r2", logicalName: "teamtasks-files" },
        ],
      },
      {
        ...environment,
        resources: [
          ...environment.resources,
          {
            requirement: { binding: "FILES", kind: "r2", logicalName: "teamtasks-files" },
            resourceId: "bucket-1",
          },
        ],
      },
      options,
    );
    const diff = diffPlans(plan(), next);
    expect(diff.changed).toBe(true);
    expect(diff.lines.some((line) => line.startsWith("+") && line.includes("FILES"))).toBe(true);
  });

  it("loadPreviousPlan: absent file -> null; invalid file -> loud throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "can-review-"));
    expect(loadPreviousPlan(join(dir, "missing.deploy-plan.json"))).toBeNull();
    const bad = join(dir, "bad.deploy-plan.json");
    writeFileSync(bad, "{ not json");
    expect(() => loadPreviousPlan(bad)).toThrow(/deploy-plan/);
  });

  it("confirm gate blocks without --yes", () => {
    expect(() => requireYes(false, "deploy")).toThrow(/--yes/);
    expect(() => requireYes(true, "deploy")).not.toThrow();
  });

  it("preview formats a human-readable plan + diff", () => {
    const text = formatPreview(plan(), diffPlans(null, plan()));
    expect(text).toContain("teamtasks");
    expect(text).toContain("compatibility_date");
  });
});

describe("upgrade apply (B5-J3)", () => {
  const upgradePlan = {
    from: [{ owner: "teamtasks", snapshotId: "snap-1" }],
    to: descriptor.identity,
    pendingWork: [],
  };

  it("dry-run is the default: staged states, no side effects", () => {
    const result = applyUpgrade(upgradePlan);
    expect(result.dryRun).toBe(true);
    expect(result.states.map((state) => state.stage)).toEqual([
      "proposed",
      "admissions-closed",
      "staging",
      "staged",
      "activating",
      "active",
    ]);
    expect(result.states.at(-1)?.progress).toEqual({ stagedOwners: 1, totalOwners: 1 });
  });

  it("live apply refuses: no wrangler spawn, follow-up named", () => {
    expect(() => applyUpgrade(upgradePlan, { dryRun: false })).toThrow(/wrangler/i);
  });
});
