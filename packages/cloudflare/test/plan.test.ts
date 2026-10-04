import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION, type CompatibilityDescriptor } from "@canlang/contracts";
import { buildDeployPlan } from "../src/deploy/plan.js";

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
  resourceBindings: [
    { binding: "DB", kind: "d1", logicalName: "teamtasks-db" },
    { binding: "FILES", kind: "r2", logicalName: "teamtasks-files" },
    { binding: "CALENDAR", kind: "durable-object", logicalName: "CalendarAuthority" },
    { binding: "OUTBOX", kind: "queue", logicalName: "teamtasks-outbox" },
    { binding: "IDP", kind: "service", logicalName: "identity-provider" },
    { binding: "METRICS", kind: "analytics-engine", logicalName: "teamtasks-metrics" },
  ],
  secrets: [{ binding: "MAIL_KEY", optional: false }],
  schedules: [{ handler: "team.Remind", everyMilliseconds: "86400000" }],
};

const environment = {
  environment: "staging",
  resources: [
    { requirement: descriptor.resourceBindings[0]!, resourceId: "db-id" },
    { requirement: descriptor.resourceBindings[1]!, resourceId: "r2-id" },
    { requirement: descriptor.resourceBindings[2]!, resourceId: "do-id" },
    { requirement: descriptor.resourceBindings[3]!, resourceId: "queue-id" },
    { requirement: descriptor.resourceBindings[4]!, resourceId: "svc-id" },
    { requirement: descriptor.resourceBindings[5]!, resourceId: "ae-id" },
  ],
  secretsPresent: ["MAIL_KEY"],
  vars: { LOCALE: "locale-en-canary" },
};

const options = { workerName: "teamtasks", main: "./dist/worker/entry.js", compatibilityDate: "2026-10-04" };

describe("buildDeployPlan", () => {
  it("maps every binding kind to its wrangler section", () => {
    const plan = buildDeployPlan(descriptor, environment, options);
    expect(plan.wrangler).toEqual({
      name: "teamtasks",
      main: "./dist/worker/entry.js",
      compatibility_date: "2026-10-04",
      vars: { LOCALE: "locale-en-canary" },
      d1_databases: [{ binding: "DB", database_name: "teamtasks-db", database_id: "db-id" }],
      r2_buckets: [{ binding: "FILES", bucket_name: "teamtasks-files" }],
      durable_objects: { bindings: [{ name: "CALENDAR", class_name: "CalendarAuthority" }] },
      queues: { producers: [{ binding: "OUTBOX", queue: "teamtasks-outbox" }] },
      services: [{ binding: "IDP", service: "identity-provider" }],
      analytics_engine_datasets: [{ binding: "METRICS", dataset: "teamtasks-metrics" }],
    });
  });

  it("is deterministic across runs", () => {
    const first = buildDeployPlan(descriptor, environment, options);
    const second = buildDeployPlan(descriptor, environment, options);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("never emits secret names or values", () => {
    const plan = buildDeployPlan(descriptor, environment, options);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("MAIL_KEY");
    expect(serialized).toContain("locale-en-canary");
  });

  it("passes schedules through unmapped and throws on unresolved bindings", () => {
    const plan = buildDeployPlan(descriptor, environment, options);
    expect(plan.schedules).toEqual(descriptor.schedules);
    expect(plan.schedules).not.toBe(descriptor.schedules);
    expect(() => buildDeployPlan(descriptor, { ...environment, resources: [] }, options)).toThrow(
      /binding DB/,
    );
    expect(() =>
      buildDeployPlan(
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
        options,
      ),
    ).toThrow(/different requirement/);
  });
});
