/**
 * B3-I6 activation tests (`src/deploy/activate.ts`).
 *
 * Failing-first: this suite was written before the module existed. The
 * inventory gate runs through the REAL producer functions (test-only
 * cross-package source imports, mirroring `assembly.test.ts`): the real
 * `buildWorkInventory` (`@canlang/work`) and the real
 * `checkActivationInventory` (`@canlang/state`). The only adapter is the
 * plan cast: the real checker reads ONLY `migrationId` + `invalidates`
 * (`packages/state/src/migration/activate.ts`), so the minimal
 * `ActivationPlan` is runtime-compatible; re-verify if that signature is
 * ever extended beyond additive.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  type CompatibilityDescriptor,
  type CompileArtifact,
  type EnvironmentSelection,
  type InstalledSnapshot,
  type OutboxIntent,
  type OutboxItem,
  type StoragePort,
} from "@canlang/contracts";
import { buildWorkInventory } from "../../work/src/recovery/index.ts";
import { checkActivationInventory } from "../../state/src/migration/activate.ts";
import type { ValidatedMigrationPlan } from "../../state/src/migration/transition.ts";
import { activate, type ActivationGates, type ActivationPlan } from "../src/deploy/activate.js";
import { KNOWN_CAPABILITIES, probeInstalledRuntime } from "../src/deploy/installed.js";
import type { InstalledRuntime } from "../src/deploy/compat.js";

/* ------------------------------------------------------------------ */
/* Fixtures.                                                           */
/* ------------------------------------------------------------------ */

const DIGEST = "a".repeat(64);

function fixtureArtifact(requires: CompileArtifact["requires"]): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "1.0.0",
    tool_version: "activate-fixture/0 (hand-written; NOT compiler output)",
    sources: [{ path: "examples/TeamTasks.can", sha256: "b".repeat(64) }],
    modules: [],
    callables: [],
    pages: [],
    requires,
    tests: [],
  };
}

function fixtureDescriptor(overrides: Partial<CompatibilityDescriptor> = {}): CompatibilityDescriptor {
  return {
    identity: {
      appName: "TeamTasks",
      sourceRevision: "14fa6a0",
      languageVersion: "1.0.0",
      compilerVersion: "0.1.0",
      contractsVersion: CONTRACTS_VERSION,
      artifactDigest: DIGEST,
    },
    requiredCapabilities: ["d1-batch"],
    resourceBindings: [{ binding: "DB", kind: "d1", logicalName: "teamtasks-db" }],
    secrets: [{ binding: "MAIL_KEY", optional: false }],
    schedules: [],
    ...overrides,
  };
}

function fixtureEnvironment(): EnvironmentSelection {
  return {
    environment: "local",
    resources: [
      {
        requirement: { binding: "DB", kind: "d1", logicalName: "teamtasks-db" },
        resourceId: "local-d1",
      },
    ],
    secretsPresent: ["MAIL_KEY"],
    vars: {},
  };
}

function fixtureInstalled(capabilities: readonly string[] = ["d1-batch", "state"]): InstalledRuntime {
  return probeInstalledRuntime(
    {},
    {
      contractsVersion: CONTRACTS_VERSION,
      runtimeVersion: "activate-fixture/0",
      knownLanguageVersions: ["1.0.0"],
      capabilities,
      supportsSchedules: false,
    },
  );
}

interface FakeStoreOptions {
  installedSnapshot: InstalledSnapshot | null;
  outbox: readonly OutboxIntent[];
  readInstalledSnapshotError?: Error;
}

function fakeStore(options: FakeStoreOptions): StoragePort {
  return {
    readInstalledSnapshot: async () => {
      if (options.readInstalledSnapshotError !== undefined) throw options.readInstalledSnapshotError;
      return options.installedSnapshot;
    },
    outboxPending: async () => options.outbox,
  } as unknown as StoragePort;
}

function installedSnapshot(digest: string): InstalledSnapshot {
  return {
    owner: "TeamTasks",
    snapshotId: "snap-1",
    digest,
    installedRevision: 7 as never,
    installedAt: 1_700_000_000_000,
  };
}

function fixturePlan(): ActivationPlan {
  return { migrationId: "mig-fixture-1", invalidates: ["teamtasks.todo.v1"] };
}

/** Real gates: the builder passes straight through; the checker needs the plan cast. */
function realGates(): ActivationGates {
  return {
    buildWorkInventory,
    checkActivationInventory: (store, plan, inventory) =>
      checkActivationInventory(store, plan as unknown as ValidatedMigrationPlan, inventory),
  };
}

function outboxItem(id: string, state: OutboxItem["state"]): OutboxItem {
  return {
    id,
    operationId: "01920000-0000-7000-8000-000000000000",
    source: "teamtasks.todo",
    occurrenceIndex: 0,
    request: {},
    originOccurrence: null,
    attempts: 0,
    state,
  };
}

function outboxIntent(id: string): OutboxIntent {
  return {
    intentId: id,
    operation: "teamtasks.todo" as never,
    operationId: "01920000-0000-7000-8000-000000000000" as never,
    target: "teamtasks.todo",
    arguments: {},
    occurrenceIndex: 0,
  };
}

const contractFor = (_item: OutboxItem): string | null => "teamtasks.todo.v1";

/* ------------------------------------------------------------------ */
/* Gate 1 (compat) + gate 2 (requires bridge).                         */
/* ------------------------------------------------------------------ */

describe("activate", () => {
  it("returns active when every gate passes (real inventory gates, empty outbox)", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([{ capability: "state", min_version: 1 }]),
      descriptor: fixtureDescriptor(),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({ installedSnapshot: installedSnapshot(DIGEST), outbox: [] }),
      inventory: { outboxItems: [], handlerContractFor: contractFor, plan: fixturePlan() },
      gates: realGates(),
    });
    expect(verdict).toEqual({ active: true });
  });

  it("passes compat failures through with their codes", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor(),
      environment: { ...fixtureEnvironment(), resources: [] },
      installed: fixtureInstalled(),
      store: fakeStore({ installedSnapshot: installedSnapshot(DIGEST), outbox: [] }),
      inventory: { outboxItems: [], handlerContractFor: contractFor, plan: fixturePlan() },
      gates: realGates(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons[0]).toMatchObject({ code: "missing-binding" });
    }
  });

  it("blocks a requires id the target does not install (missing-capability)", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([{ capability: "values.decimal", min_version: 1 }]),
      descriptor: fixtureDescriptor({ requiredCapabilities: [] }),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(["d1-batch", "state"]),
      store: fakeStore({ installedSnapshot: installedSnapshot(DIGEST), outbox: [] }),
      inventory: { outboxItems: [], handlerContractFor: contractFor, plan: fixturePlan() },
      gates: realGates(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons).toEqual([
        { code: "missing-capability", detail: expect.stringContaining("values.decimal") },
      ]);
    }
  });

  it("fails closed on an unknown requires id (unknown-capability)", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([{ capability: "teleport.v1", min_version: 1 }]),
      descriptor: fixtureDescriptor({ requiredCapabilities: [] }),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({ installedSnapshot: installedSnapshot(DIGEST), outbox: [] }),
      inventory: { outboxItems: [], handlerContractFor: contractFor, plan: fixturePlan() },
      gates: realGates(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons).toEqual([
        { code: "unknown-capability", detail: expect.stringContaining("teleport.v1") },
      ]);
    }
  });

  it("upgrades unknown descriptor capabilities to unknown-capability, keeps known-missing as missing", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor({ requiredCapabilities: ["do-alarms", "teleport.v1"] }),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({ installedSnapshot: installedSnapshot(DIGEST), outbox: [] }),
      inventory: { outboxItems: [], handlerContractFor: contractFor, plan: fixturePlan() },
      gates: realGates(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons).toEqual([
        { code: "missing-capability", detail: "do-alarms" },
        { code: "unknown-capability", detail: "teleport.v1" },
      ]);
    }
  });

  it("keeps the requires bridge table inside the known registry", async () => {
    const { REQUIRES_CAPABILITY_MAP } = await import("../src/deploy/activate.js");
    for (const [requiresId, capabilityIds] of Object.entries(REQUIRES_CAPABILITY_MAP)) {
      expect(requiresId.length).toBeGreaterThan(0);
      expect(capabilityIds.length).toBeGreaterThan(0);
      for (const id of capabilityIds) {
        expect(KNOWN_CAPABILITIES).toContain(id);
      }
    }
  });

  /* ---------------- Gate 3 (installed digest). ---------------- */

  it("blocks when the served digest disagrees with the installed snapshot", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor(),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({ installedSnapshot: installedSnapshot("c".repeat(64)), outbox: [] }),
      inventory: { outboxItems: [], handlerContractFor: contractFor, plan: fixturePlan() },
      gates: realGates(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons).toEqual([
        { code: "digest-mismatch", detail: expect.stringContaining("TeamTasks") },
      ]);
    }
  });

  it("passes the digest gate on a fresh install (no installed snapshot)", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor(),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({ installedSnapshot: null, outbox: [] }),
      inventory: { outboxItems: [], handlerContractFor: contractFor, plan: fixturePlan() },
      gates: realGates(),
    });
    expect(verdict).toEqual({ active: true });
  });

  it("fails closed (never throws) when the snapshot read errors", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor(),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({
        installedSnapshot: null,
        outbox: [],
        readInstalledSnapshotError: new Error("D1 down"),
      }),
      inventory: { outboxItems: [], handlerContractFor: contractFor, plan: fixturePlan() },
      gates: realGates(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons[0]).toMatchObject({ code: "activation-check-failed" });
      expect(verdict.reasons[0]?.detail).toContain("D1 down");
    }
  });

  /* ---------------- Gate 4 (outstanding work, real L3/L4). ---------------- */

  it("blocks non-undispatched inventory (claimed work names its intent)", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor(),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({ installedSnapshot: installedSnapshot(DIGEST), outbox: [] }),
      inventory: {
        outboxItems: [outboxItem("intent-claimed-1", "claimed")],
        handlerContractFor: contractFor,
        plan: fixturePlan(),
      },
      gates: realGates(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons).toHaveLength(1);
      expect(verdict.reasons[0]).toMatchObject({ code: "blocked-work" });
      expect(verdict.reasons[0]?.detail).toContain("intent-claimed-1");
    }
  });

  it("blocks undispatched inventory with no pinned contract", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor(),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({
        installedSnapshot: installedSnapshot(DIGEST),
        outbox: [outboxIntent("intent-pending-1")],
      }),
      inventory: {
        outboxItems: [outboxItem("intent-pending-1", "pending")],
        handlerContractFor: () => "some.unpinned-contract",
        plan: fixturePlan(),
      },
      gates: realGates(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons).toEqual([
        { code: "blocked-work", detail: expect.stringContaining("intent-pending-1") },
      ]);
    }
  });

  it("passes pinned undispatched inventory still pending in the outbox", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor(),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({
        installedSnapshot: installedSnapshot(DIGEST),
        outbox: [outboxIntent("intent-pending-1")],
      }),
      inventory: {
        outboxItems: [outboxItem("intent-pending-1", "pending")],
        handlerContractFor: contractFor,
        plan: fixturePlan(),
      },
      gates: realGates(),
    });
    expect(verdict).toEqual({ active: true });
  });

  it("fails closed when the contract vocabulary cannot map an item", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor(),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({ installedSnapshot: installedSnapshot(DIGEST), outbox: [] }),
      inventory: {
        outboxItems: [outboxItem("intent-unmapped-1", "pending")],
        handlerContractFor: () => null,
        plan: fixturePlan(),
      },
      gates: realGates(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons).toEqual([
        { code: "blocked-work", detail: expect.stringContaining("intent-unmapped-1") },
      ]);
    }
  });

  /* ---------------- Fail-closed wiring. ---------------- */

  it("collects every gate failure in deterministic order, never throws", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([{ capability: "teleport.v1", min_version: 1 }]),
      descriptor: fixtureDescriptor({ requiredCapabilities: ["do-alarms"] }),
      environment: { ...fixtureEnvironment(), resources: [] },
      installed: fixtureInstalled(),
      store: fakeStore({ installedSnapshot: installedSnapshot("c".repeat(64)), outbox: [] }),
      inventory: {
        outboxItems: [outboxItem("intent-claimed-9", "claimed")],
        handlerContractFor: contractFor,
        plan: fixturePlan(),
      },
      gates: realGates(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons.map((reason) => reason.code)).toEqual([
        "missing-capability",
        "missing-binding",
        "unknown-capability",
        "digest-mismatch",
        "blocked-work",
      ]);
    }
  });

  it("blocks (never passes, never throws) when store-backed inputs are absent", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor(),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons).toEqual([
        {
          code: "activation-incomplete",
          detail: expect.stringContaining("store-backed"),
        },
      ]);
    }
  });

  it("blocks the inventory gate when only the store is supplied", async () => {
    const verdict = await activate({
      artifact: fixtureArtifact([]),
      descriptor: fixtureDescriptor(),
      environment: fixtureEnvironment(),
      installed: fixtureInstalled(),
      store: fakeStore({ installedSnapshot: installedSnapshot(DIGEST), outbox: [] }),
    });
    expect(verdict.active).toBe(false);
    if (!verdict.active) {
      expect(verdict.reasons).toEqual([
        { code: "activation-incomplete", detail: expect.stringContaining("inventory") },
      ]);
    }
  });
});
