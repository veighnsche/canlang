/**
 * Activation bundle evidence shared by the `activate` and `deploy` CLI
 * paths: optional store snapshot + compiled transition loading, the
 * read-only bundle store stub, and the gate-4 producer join over bundle
 * evidence.
 *
 * Bundle evidence covers undispatched outbox rows only (dispatch
 * claimed/uncertain/settled lifecycle rides the live upgrade path via
 * `buildUpgradeInventory`, not the bundle). Absent store/transition
 * files read as null (gates report `activation-incomplete`); malformed
 * files fail loud at load.
 */
import { access, constants } from "node:fs/promises";
import type {
  InstalledSnapshot,
  MigrationTransition,
  OutboxIntent,
  StoragePort,
} from "@canlang/contracts";
import { buildWorkInventory } from "@canlang/work";
import { checkActivationInventory, type ValidatedMigrationPlan } from "@canlang/state/migration";
import { handlerContractForOutboxItem, outboxItemsFromPending } from "../upgrade/inventory.js";
import type { ActivationGates, WorkInventorySource } from "./activate.js";
import { loadBundleJson, needRecord, needString } from "../preparation/host.js";

export interface BundleStore {
  readonly installedSnapshot: InstalledSnapshot | null;
  readonly outbox: readonly OutboxIntent[];
}

async function bundleFileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadBundleStore(path: string): Promise<BundleStore | null> {
  if (!(await bundleFileExists(path))) return null;
  const root = needRecord(loadBundleJson(path, "store"), "store");
  const installed = root["installedSnapshot"];
  if (installed !== null) {
    const snapshot = needRecord(installed, "store.installedSnapshot");
    needString(snapshot["owner"], "store.installedSnapshot.owner");
    needString(snapshot["snapshotId"], "store.installedSnapshot.snapshotId");
    needString(snapshot["digest"], "store.installedSnapshot.digest");
    if (typeof snapshot["installedRevision"] !== "number" || typeof snapshot["installedAt"] !== "number") {
      throw new Error("store.installedSnapshot.installedRevision/installedAt must be numbers");
    }
  }
  if (!Array.isArray(root["outbox"])) throw new Error("store.outbox must be an array");
  for (const [index, intent] of (root["outbox"] as unknown[]).entries()) {
    const entry = needRecord(intent, `store.outbox[${index}]`);
    needString(entry["intentId"], `store.outbox[${index}].intentId`);
    needString(entry["operation"], `store.outbox[${index}].operation`);
    needString(entry["operationId"], `store.outbox[${index}].operationId`);
    if (typeof entry["occurrenceIndex"] !== "number" || !Number.isInteger(entry["occurrenceIndex"])) {
      throw new Error(`store.outbox[${index}].occurrenceIndex must be an integer`);
    }
    needRecord(entry["arguments"], `store.outbox[${index}].arguments`);
  }
  return root as unknown as BundleStore;
}

/**
 * Gate-4 transition source: the bundle's compiled `MigrationTransition`.
 * Absent file -> null; invalid file -> loud failure. Closed-shape
 * validation only — the engine revalidates semantics.
 */
export async function loadBundleTransition(path: string): Promise<MigrationTransition | null> {
  if (!(await bundleFileExists(path))) return null;
  const root = needRecord(loadBundleJson(path, "transition"), "transition");
  for (const name of ["migrationId", "owner", "fromSnapshotId", "fromDigest", "toSnapshotId", "toDigest", "bodyDigest"]) {
    needString(root[name], `transition.${name}`);
  }
  if (!Array.isArray(root["directives"])) throw new Error("transition.directives must be an array");
  const SHAPES: Readonly<Record<string, ReadonlyArray<string>>> = {
    renameOwner: ["from"],
    dropOwner: [],
    renameModel: ["from", "to"],
    renameField: ["model", "from", "to"],
    dropModel: ["model"],
    dropField: ["model", "field"],
    backfill: ["model"],
    invalidate: ["handlerContract"],
  };
  for (const [index, directive] of (root["directives"] as unknown[]).entries()) {
    const entry = needRecord(directive, `transition.directives[${index}]`);
    const kind = entry["kind"];
    if (typeof kind !== "string" || !(kind in SHAPES)) {
      throw new Error(`transition.directives[${index}].kind names no known directive`);
    }
    for (const field of SHAPES[kind]!) needString(entry[field], `transition.directives[${index}].${field}`);
  }
  return root as unknown as MigrationTransition;
}

/**
 * Read-only bundle store stub: owner-scoped installed snapshot plus a
 * copy of the pending outbox rows.
 */
export function bundleStoreStub(bundleStore: BundleStore): Pick<StoragePort, "readInstalledSnapshot" | "outboxPending"> {
  return {
    readInstalledSnapshot: async (owner: string) =>
      bundleStore.installedSnapshot !== null && bundleStore.installedSnapshot.owner === owner
        ? bundleStore.installedSnapshot
        : null,
    outboxPending: async () => [...bundleStore.outbox],
  };
}

/**
 * Gate-4 producer join over bundle evidence: bundle outbox rows become
 * inventory items through the real builder, and the transition's
 * invalidate contracts pin disposal through the real checker. The
 * checker reads ONLY `migrationId` + `invalidates` off the plan
 * (verified at `packages/state/src/migration/activate.ts`), so the
 * minimal plan view adapts soundly.
 */
export function bundleInventoryGates(
  bundleStore: BundleStore,
  transition: MigrationTransition,
): { inventory: WorkInventorySource; gates: ActivationGates } {
  const invalidates = transition.directives
    .filter((directive) => directive.kind === "invalidate")
    .map((directive) => (directive as { handlerContract: string }).handlerContract);
  return {
    inventory: {
      outboxItems: outboxItemsFromPending([...bundleStore.outbox]),
      handlerContractFor: handlerContractForOutboxItem,
      plan: { migrationId: transition.migrationId, invalidates },
    },
    gates: {
      buildWorkInventory: (input) => buildWorkInventory(input),
      checkActivationInventory: (store, plan, items) =>
        checkActivationInventory(store, plan as unknown as ValidatedMigrationPlan, items),
    },
  };
}
