/**
 * B3-I6 activation: the serve gate. `activate` runs the four activation
 * checks in deterministic order and returns a typed `ActivationVerdict` —
 * it never throws verdict failures (only programmer bugs: a non-record
 * input or a malformed gate result).
 *
 * The gates:
 *  1. `checkCompatibility` (the pure installed-artifact/capability/
 *     binding/secret/schedule gate), with an additive post-pass that
 *     upgrades unknown ids to `unknown-capability` via the
 *     `KNOWN_CAPABILITIES` registry (`compat.ts` itself still collapses
 *     unknown into missing; that file is owned elsewhere).
 *  2. Artifact `requires[]` vs `installed.capabilities` through the
 *     explicit `REQUIRES_CAPABILITY_MAP` bridge. Requires ids outside
 *     the table fail closed with `unknown-capability`; mapped ids the
 *     target does not install fail with `missing-capability`.
 *     LIMITATION (loud): `min_version` pins are NOT verified — the
 *     installed registry carries no versions, so presence is all the
 *     bridge can prove. The wanted version rides the reason detail.
 *  3. Installed-snapshot digest agreement: the served artifact digest
 *     (`descriptor.identity.artifactDigest`) must equal the installed
 *     snapshot digest for the app owner. A missing snapshot is a fresh
 *     install and passes (S7: fresh installs never apply transitions,
 *     so there is no predecessor to disagree with).
 *  4. Outstanding-work inventory: `buildWorkInventory` enumerates live
 *     outbox work, then `checkActivationInventory` enforces the
 *     invalidate-only-undispatched+pinned rule. Any throw from either
 *     producer blocks with `blocked-work` (builder) or `blocked-work` /
 *     `activation-check-failed` (checker: `StateError` vs anything
 *     else, classified structurally — see below).
 *
 * Producer seams: this package has no runtime dependency on
 * `@canlang/state` or `@canlang/work`, so both gate functions arrive
 * injected (`ActivationGates`) typed against their EXISTING signatures
 * (positional `(store, plan, inventory)`; single-object
 * `{ outboxItems, handlerContractFor }`). Additive extension of those
 * signatures stays compatible: this module only ever calls the existing
 * shape. The plan is the minimal structural view the checker reads
 * (`migrationId` + `invalidates`); attestation stays injected (L4 owes
 * the real `handlerContractFor` mapping). Schedule-backend verification
 * is out of scope (OPEN-139).
 *
 * Fail-closed wiring: `store` runs gate 3 alone; `inventory` + `gates`
 * run gate 4 together. Any absent group blocks with a single
 * `activation-incomplete` reason — a verdict NEVER claims active with
 * an unchecked gate.
 */

import type {
  ActivationFailure,
  ActivationVerdict,
  CompatibilityDescriptor,
  CompatibilityFailure,
  CompileArtifact,
  EnvironmentSelection,
  MigrationOutcome,
  OutboxItem,
  StoragePort,
  WorkInventoryItem,
} from "@canlang/contracts";
import { checkCompatibility, type InstalledRuntime } from "./compat.js";
import { KNOWN_CAPABILITIES } from "./installed.js";

/**
 * Explicit requires-id -> installed-capability bridge. Identity today:
 * the installed runtime advertises exactly the producer ids it
 * implements. Non-identity mappings (if the vocabulary owner ever
 * defines them) land here — nowhere else may map these vocabularies.
 * Every target must stay inside `KNOWN_CAPABILITIES` (pinned by test).
 */
export const REQUIRES_CAPABILITY_MAP: Readonly<Record<string, readonly string[]>> = {
  "canlang.builtins": ["canlang.builtins"],
  "values.decimal": ["values.decimal"],
  "values.int64": ["values.int64"],
  "values.money": ["values.money"],
  "values.temporal": ["values.temporal"],
  state: ["state"],
  "state.machines": ["state.machines"],
  "state.parameters": ["state.parameters"],
  "interfaces.input-choices": ["interfaces.input-choices"],
};

/**
 * Minimal plan view the inventory checker reads: `migrationId` (for
 * outcome records) + `invalidates` (pinned handler contracts). The real
 * `checkActivationInventory` reads ONLY these two fields (verified at
 * `packages/state/src/migration/activate.ts`); callers adapt this view
 * to the full plan type at the injection site.
 */
export interface ActivationPlan {
  readonly migrationId: string;
  readonly invalidates: ReadonlyArray<string>;
}

/** Minimal disposition view the inventory checker returns. */
export interface ActivationDisposition {
  readonly invalidatedIntentIds: ReadonlyArray<string>;
  readonly outcomes: ReadonlyArray<MigrationOutcome>;
}

/** Live-work source for the inventory gate (L4/L7 attestation, injected). */
export interface WorkInventorySource {
  readonly outboxItems: ReadonlyArray<OutboxItem>;
  /**
   * Deployment vocabulary: must return the same strings the plan pins.
   * Null/empty means unmappable — the builder throws, activation blocks.
   */
  readonly handlerContractFor: (item: OutboxItem) => string | null;
  readonly plan: ActivationPlan;
}

/**
 * Injected producer gates, mirroring the EXISTING signatures:
 * `buildWorkInventory({ outboxItems, handlerContractFor })` and
 * `checkActivationInventory(store, plan, inventory)`.
 */
export interface ActivationGates {
  readonly buildWorkInventory: (input: {
    readonly outboxItems: ReadonlyArray<OutboxItem>;
    readonly handlerContractFor: (item: OutboxItem) => string | null;
  }) => WorkInventoryItem[];
  readonly checkActivationInventory: (
    store: StoragePort,
    plan: ActivationPlan,
    inventory: ReadonlyArray<WorkInventoryItem>,
  ) => Promise<ActivationDisposition>;
}

export interface ActivateInput {
  readonly artifact: CompileArtifact;
  readonly descriptor: CompatibilityDescriptor;
  readonly environment: EnvironmentSelection;
  readonly installed: InstalledRuntime;
  /** Absent store: gate 3 blocks with `activation-incomplete`. */
  readonly store?: StoragePort;
  /** Absent inventory or gates: gate 4 blocks with `activation-incomplete`. */
  readonly inventory?: WorkInventorySource;
  readonly gates?: ActivationGates;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Structural `StateError` check. This package cannot import the class
 * (no `@canlang/state` dependency), so classification is by the
 * constructor-set `name` + string `code` (`state/src/errors.ts` sets
 * both unconditionally). A coded-but-foreign error inside the checker
 * mislabels as `blocked-work` — both block, and the detail preserves
 * the raw message, so the failure stays loud either way.
 */
function isStateErrorShaped(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "StateError" && typeof candidate.code === "string";
}

/**
 * Gate 1 post-pass: `checkCompatibility` collapses unknown descriptor
 * capability ids into `missing-capability`; upgrade the ones outside
 * the known registry to `unknown-capability`. Additive only — every
 * other reason passes through verbatim, order preserved.
 */
function upgradeUnknownCapabilities(reasons: readonly CompatibilityFailure[]): ActivationFailure[] {
  const known = new Set(KNOWN_CAPABILITIES);
  return reasons.map((reason) =>
    reason.code === "missing-capability" && !known.has(reason.detail)
      ? { code: "unknown-capability", detail: reason.detail }
      : { code: reason.code, detail: reason.detail },
  );
}

/** Gate 2: artifact `requires[]` vs installed capabilities via the map table. */
function checkRequires(
  artifact: CompileArtifact,
  installed: InstalledRuntime,
): ActivationFailure[] {
  const have = new Set(installed.capabilities);
  const failures: ActivationFailure[] = [];
  for (const requirement of artifact.requires) {
    const mapped = Object.hasOwn(REQUIRES_CAPABILITY_MAP, requirement.capability)
      ? REQUIRES_CAPABILITY_MAP[requirement.capability]
      : undefined;
    if (mapped === undefined) {
      failures.push({
        code: "unknown-capability",
        detail:
          `artifact requires unknown capability ${JSON.stringify(requirement.capability)} ` +
          `(min_version ${requirement.min_version})`,
      });
      continue;
    }
    for (const id of mapped) {
      if (!have.has(id)) {
        failures.push({
          code: "missing-capability",
          detail:
            `artifact requires ${JSON.stringify(requirement.capability)} ` +
            `(min_version ${requirement.min_version}) but the target does not install it`,
        });
      }
    }
  }
  return failures;
}

/** Gate 3: served digest vs installed snapshot digest (null snapshot = fresh install). */
async function checkDigest(
  descriptor: CompatibilityDescriptor,
  store: StoragePort,
): Promise<ActivationFailure[]> {
  const owner = descriptor.identity.appName;
  let installed;
  try {
    installed = await store.readInstalledSnapshot(owner);
  } catch (error) {
    return [
      {
        code: "activation-check-failed",
        detail: `installed-snapshot read for ${JSON.stringify(owner)} failed: ${errorMessage(error)}`,
      },
    ];
  }
  if (installed === null) return [];
  if (installed.digest !== descriptor.identity.artifactDigest) {
    return [
      {
        code: "digest-mismatch",
        detail:
          `served artifact digest ${JSON.stringify(descriptor.identity.artifactDigest)} disagrees with ` +
          `installed snapshot ${JSON.stringify(installed.snapshotId)} digest ${JSON.stringify(installed.digest)} ` +
          `for owner ${JSON.stringify(owner)}`,
      },
    ];
  }
  return [];
}

/** Gate 4: live-work inventory through the injected producer gates. */
async function checkInventory(
  store: StoragePort,
  inventory: WorkInventorySource,
  gates: ActivationGates,
): Promise<ActivationFailure[]> {
  let items: WorkInventoryItem[];
  try {
    items = gates.buildWorkInventory({
      outboxItems: inventory.outboxItems,
      handlerContractFor: inventory.handlerContractFor,
    });
  } catch (error) {
    return [{ code: "blocked-work", detail: errorMessage(error) }];
  }
  if (!Array.isArray(items)) {
    throw new Error("activate: buildWorkInventory must return an array");
  }
  try {
    await gates.checkActivationInventory(store, inventory.plan, items);
  } catch (error) {
    if (isStateErrorShaped(error)) {
      return [{ code: "blocked-work", detail: errorMessage(error) }];
    }
    return [
      {
        code: "activation-check-failed",
        detail: `activation inventory check failed: ${errorMessage(error)}`,
      },
    ];
  }
  return [];
}

/**
 * Run the four activation gates; return the typed verdict. Collects
 * EVERY gate failure in gate order (compat, requires, digest,
 * inventory) — never short-circuits, never throws verdict failures.
 */
export async function activate(input: ActivateInput): Promise<ActivationVerdict> {
  const reasons: ActivationFailure[] = [];

  const compat = checkCompatibility(input.descriptor, input.environment, input.installed);
  if (!compat.compatible) {
    reasons.push(...upgradeUnknownCapabilities(compat.reasons));
  }

  reasons.push(...checkRequires(input.artifact, input.installed));

  if (input.store === undefined) {
    reasons.push({
      code: "activation-incomplete",
      detail:
        "no store: the store-backed digest + outstanding-work inventory gates are unchecked, " +
        "activation cannot proceed",
    });
  } else {
    reasons.push(...(await checkDigest(input.descriptor, input.store)));
    if (input.inventory === undefined || input.gates === undefined) {
      const missing = [
        input.inventory === undefined ? "inventory" : null,
        input.gates === undefined ? "gates (@canlang/state + @canlang/work producer join)" : null,
      ].filter((part) => part !== null);
      reasons.push({
        code: "activation-incomplete",
        detail: `outstanding-work inventory gate unchecked (missing ${missing.join(", ")})`,
      });
    } else {
      reasons.push(...(await checkInventory(input.store, input.inventory, input.gates)));
    }
  }

  return reasons.length === 0 ? { active: true } : { active: false, reasons };
}
