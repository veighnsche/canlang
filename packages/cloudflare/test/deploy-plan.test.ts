import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION, type CompatibilityDescriptor } from "@canlang/contracts";
import { buildDeployPlan, type DeployBundleRef } from "../src/deploy/plan.js";
import { renderDeployPlan } from "../src/deploy/render.js";

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
  vars: {},
} as const;

const bundle: DeployBundleRef = {
  main: "./teamtasks.deploy/worker/main.js",
  moduleCount: 42,
  sha256: "a".repeat(64),
};

describe("deploy plan bundle main (P-B)", () => {
  it("emits the bundle as the deploy main when a bundle ref is supplied", () => {
    const plan = buildDeployPlan(descriptor, environment, {
      workerName: "teamtasks",
      main: "./dist/worker/entry.js",
      compatibilityDate: "2026-10-04",
      bundle,
    });
    expect(plan.wrangler.main).toBe("./teamtasks.deploy/worker/main.js");
    expect(plan.bundle).toEqual(bundle);
  });

  it("without a bundle ref keeps the passed main and a null bundle", () => {
    const plan = buildDeployPlan(descriptor, environment, {
      workerName: "teamtasks",
      main: "./dist/worker/entry.js",
      compatibilityDate: "2026-10-04",
    });
    expect(plan.wrangler.main).toBe("./dist/worker/entry.js");
    expect(plan.bundle).toBeNull();
  });

  it("renders the bundle main + bundle comment in TOML and the ref in JSON", () => {
    const plan = buildDeployPlan(descriptor, environment, {
      workerName: "teamtasks",
      main: "./dist/worker/entry.js",
      compatibilityDate: "2026-10-04",
      bundle,
    });
    const rendered = renderDeployPlan(plan);
    expect(rendered.toml).toContain('main = "./teamtasks.deploy/worker/main.js"');
    expect(rendered.toml).toContain(`# bundle: 42 modules, sha256 ${"a".repeat(64)}`);
    expect(JSON.parse(rendered.json)).toMatchObject({ bundle });
    // Legacy render (no bundle) gains no bundle comment.
    const legacy = renderDeployPlan(
      buildDeployPlan(descriptor, environment, {
        workerName: "teamtasks",
        main: "./dist/worker/entry.js",
        compatibilityDate: "2026-10-04",
      }),
    );
    expect(legacy.toml).toContain('main = "./dist/worker/entry.js"');
    expect(legacy.toml).not.toContain("# bundle:");
  });

  it("stays deterministic with a bundle ref", () => {
    const options = {
      workerName: "teamtasks",
      main: "./dist/worker/entry.js",
      compatibilityDate: "2026-10-04",
      bundle,
    } as const;
    const first = buildDeployPlan(descriptor, environment, options);
    const second = buildDeployPlan(descriptor, environment, options);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(renderDeployPlan(second)).toEqual(renderDeployPlan(first));
  });
});
