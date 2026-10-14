/**
 * Conservative generation-unit association (BGI-02): unique matching of
 * discovered units to saved records, opaque ID allocation, and explicit
 * bind/copy reconciliation.
 *
 * Current semantic selectors and exact unchanged local certificates
 * establish ownership; legacy association evidence remains readable.
 * Displaced or competing claims require explicit `bind`, never prompt
 * similarity, nearest offsets or an unmatched-pair guess. This module
 * is pure; `records.ts` owns saved-group intake.
 */

import { randomBytes } from "node:crypto";
import type {
  GenerationUnitId,
  LocalRegionCertificate,
  SourceAssociation,
  UnitContract,
  UnitKind,
  UnitRecord,
} from "./records.js";
import { UNIT_ABI_VERSION, sha256HexText } from "./records.js";

/**
 * Current inspected location of one discovered unit: the
 * workspace-relative path, source revision (SHA-256 of the file text),
 * and byte span the descriptor was discovered from.
 */
export interface DescriptorLocation {
  path: string;
  revision: string;
  start: number;
  end: number;
}

/**
 * One discovered identity-carrying unit, as exported by compiler
 * discovery. Applications and named uses never reach association: they
 * reuse their definition without an independent identity.
 */
export interface DescriptorInput {
  owner: string;
  kind: UnitKind;
  label: string | null;
  anchor: string;
  prompt: string;
  /**
   * Current location evidence for explicit-bind honor. Absent locations
   * keep the conservative refusal: duplicate keys never reuse ownership
   * without an exact captured bind to honor.
   */
  location?: DescriptorLocation;
  selector?: string;
  region?: LocalRegionCertificate;
}

/**
 * Conservative association key: owner, kind, optional label, and the
 * normalized non-prompt anchor. Prompt text, offsets, and ordinals are
 * never evidence.
 */
export interface AssociationKey {
  owner: string;
  kind: UnitKind;
  label: string | null;
  anchor: string;
}

export function keyOfSource(source: SourceAssociation): AssociationKey {
  return { owner: source.owner, kind: source.kind, label: source.label, anchor: source.anchor };
}

export function keyOfDescriptor(descriptor: DescriptorInput): AssociationKey {
  return {
    owner: descriptor.owner,
    kind: descriptor.kind,
    label: descriptor.label,
    anchor: descriptor.anchor,
  };
}

/** Stable serialization for grouping (labels cannot collide: JSON-quoted). */
export function keyText(key: AssociationKey): string {
  return JSON.stringify([key.owner, key.kind, key.label, key.anchor]);
}

/** Human-readable key for diagnostics (`owner/kind/label` + anchor). */
export function describeKey(key: AssociationKey): string {
  return `${key.owner}/${key.kind}/${key.label ?? "-"} anchor \`${key.anchor}\``;
}

/** Association outcome for one discovered identity-carrying descriptor. */
export type UnitAssociation =
  | {
      /** Exactly one saved record carries this key; prompt-only edits keep it. */
      type: "retained";
      id: GenerationUnitId;
      promptChanged: boolean;
    }
  | {
      /** No saved record matches; preparation would allocate a fresh ID. */
      type: "new";
    }
  | {
      /**
       * More than one saved record shares the key, or more than one
       * current descriptor does (a copy). Reuse is refused; bind instead.
       */
      type: "ambiguous";
      candidates: GenerationUnitId[];
    };

/**
 * An explicit bind honored for one descriptor: exactly one same-key
 * record captured this exact source revision/location.
 */
function boundMatch(
  group: readonly UnitRecord[],
  location: DescriptorLocation | undefined,
): UnitRecord | null {
  if (location === undefined) {
    return null;
  }
  let hit: UnitRecord | null = null;
  for (const record of group) {
    if (
      record.source.path === location.path &&
      record.source.revision === location.revision &&
      record.source.start === location.start &&
      record.source.end === location.end
    ) {
      if (hit !== null) {
        return null;
      }
      hit = record;
    }
  }
  return hit;
}

function retained(descriptor: DescriptorInput, record: UnitRecord): UnitAssociation {
  return {
    type: "retained",
    id: record.id,
    promptChanged: sha256HexText(descriptor.prompt) !== record.contract.prompt_sha256,
  };
}

/**
 * Resolve all defining claims before allocating anything. Modern anonymous
 * claims retain only exact matching local certificates; legacy explicit
 * locations remain readable. A possibly displaced group makes apparent
 * new ownership ambiguous. Supply complete source paths when a live source
 * has no defining prompts, so its outputs cannot be stolen by a copy.
 */
export function associate(
  descriptors: readonly DescriptorInput[],
  saved: readonly UnitRecord[],
  sourcePaths?: readonly string[],
): Array<{ index: number; association: UnitAssociation }> {
  const semanticKey = (unit: { owner: string; kind: UnitKind; selector?: string; label: string | null; anchor: string }): string =>
    unit.selector === undefined ? keyText(unit) : JSON.stringify([unit.owner, unit.kind, unit.selector]);
  const matches = (descriptor: DescriptorInput, record: UnitRecord): boolean =>
    record.source.selector === undefined
      ? keyText(keyOfDescriptor(descriptor)) === keyText(keyOfSource(record.source))
      : semanticKey(descriptor) === semanticKey(record.source);
  const knownPaths = new Set(sourcePaths ?? descriptors.flatMap(unit => unit.location === undefined ? [] : [unit.location.path]));
  const sameDescriptor = (left: DescriptorInput, right: DescriptorInput): boolean =>
    left.selector !== undefined && right.selector !== undefined
      ? semanticKey(left) === semanticKey(right)
      : keyText(keyOfDescriptor(left)) === keyText(keyOfDescriptor(right));
  const result = descriptors.map((descriptor, index) => {
    const currentCount = descriptors.filter(current => sameDescriptor(descriptor, current)).length;
    const group = saved.filter(record => matches(descriptor, record));
    const eligible = group.filter(record => {
      if (descriptor.location !== undefined && knownPaths.has(record.source.path)
        && record.source.path !== descriptor.location.path) return false;
      if (record.source.region !== undefined) {
        const region = record.source.region;
        const conflict = group.some(claim => claim.source.region === undefined
          || claim.source.region.container !== region.container || claim.source.region.sha256 !== region.sha256
          || claim.source.region.count !== region.count);
        return !conflict && sameRegion(region, descriptor.region)
          && descriptors.filter(current => sameDescriptor(current, descriptor) && sameRegion(region, current.region)).length === 1;
      }
      if (currentCount === 1 && group.length === 1) return descriptor.region === undefined;
      return record.source.selector === undefined && boundMatch([record], descriptor.location) !== null;
    });
    const association: UnitAssociation = eligible.length === 1
      ? retained(descriptor, eligible[0] as UnitRecord)
      : group.length > 0
        ? { type: "ambiguous", candidates: group.map(record => record.id).sort() }
        : { type: "new" };
    return { index, association };
  });
  // A certificate does not allow two defining slots (or records) to own
  // one group. Decide every claim before classifying unmatched output.
  const claims = new Map<string, number>();
  for (const { association } of result) if (association.type === "retained") {
    claims.set(association.id, (claims.get(association.id) ?? 0) + 1);
  }
  const recordCounts = new Map<string, number>();
  for (const record of saved) recordCounts.set(record.id, (recordCounts.get(record.id) ?? 0) + 1);
  for (const entry of result) if (entry.association.type === "retained"
    && ((claims.get(entry.association.id) ?? 0) > 1 || (recordCounts.get(entry.association.id) ?? 0) > 1)) {
    entry.association = { type: "ambiguous", candidates: [entry.association.id] };
  }
  const consumed = new Set(result.flatMap(({ association }) => association.type === "retained" ? [association.id] : []));
  for (const entry of result) if (entry.association.type === "new") {
    const descriptor = descriptors[entry.index] as DescriptorInput;
    // The saved collection belongs to one output root. An owner rename
    // cannot turn its displaced same-kind output into a fresh generation.
    const displaced = saved.filter(record => !consumed.has(record.id)
      && record.source.kind === descriptor.kind);
    if (displaced.length > 0) entry.association = { type: "ambiguous", candidates: [...new Set(displaced.map(record => record.id))].sort() };
  }
  return result;
}

function sameRegion(saved: LocalRegionCertificate, current: LocalRegionCertificate | undefined): boolean {
  return current !== undefined && saved.container === current.container && saved.sha256 === current.sha256
    && saved.count === current.count && saved.occurrence === current.occurrence;
}

/**
 * Allocate an opaque ID with 128 random bits. Existing legacy IDs remain
 * valid; independent branches need no shared counter or registry.
 */
export function nextUnitId(used: ReadonlySet<string> | readonly string[]): GenerationUnitId {
  const taken = used instanceof Set ? used : new Set(used);
  let id: string;
  do { id = `g-${randomBytes(16).toString("hex")}`; } while (taken.has(id));
  return id;
}

/**
 * Explicit bind target: an existing saved ID, or a fresh one. `new` is
 * the copy answer: a copied unit binds with `new=true` and receives its
 * own ID and output group; it never shares mutable implementation
 * ownership with its source.
 */
export type BindTarget = { kind: "existing"; id: GenerationUnitId } | { kind: "new" };

/** Explicit reconciliation of one inspected source location. */
export interface BindRequest {
  path: string;
  revision: string;
  start: number;
  end: number;
  /** Fresh association evidence for the inspected location. */
  source: SourceAssociation;
  /** Fresh contract refs for the inspected location. */
  contract: UnitContract;
  target: BindTarget;
}

export type BindErrorCode = "stale-selector" | "unknown-unit" | "kind-mismatch";

export interface BindError {
  code: BindErrorCode;
  detail: string;
}

export type BindResult = { ok: true; record: UnitRecord } | { ok: false; error: BindError };

/**
 * Apply an explicit bind against the tracked records. On success the
 * returned record is the new association to persist to
 * `can.generated/<id>/unit.json` (persistence is the caller's,
 * lease-coordinated step). Existing binds refresh location/revision
 * evidence and contract refs while preserving original fingerprints and
 * provenance. New binds allocate a fresh ID with `bound` provenance and
 * empty original outputs. Every failure leaves saved groups intact.
 */
export function applyBind(
  saved: readonly UnitRecord[],
  request: BindRequest,
  currentRevision: string,
): BindResult {
  if (request.revision !== currentRevision) {
    return {
      ok: false,
      error: {
        code: "stale-selector",
        detail:
          `stale bind selector: inspected revision \`${request.revision}\`` +
          ` does not match current \`${currentRevision}\`; re-inspect the source location`,
      },
    };
  }
  const target = request.target;
  if (target.kind === "new") {
    const id = nextUnitId(saved.map((record) => record.id));
    return {
      ok: true,
      record: {
        abi_version: UNIT_ABI_VERSION,
        id,
        source: { ...request.source, revision: currentRevision },
        contract: request.contract,
        original: { prompt_sha256: request.contract.prompt_sha256, files: {} },
        provenance: {
          origin: "bound",
          runner: null,
          model: null,
          note: "explicit bind; no generated output yet",
        },
      },
    };
  }
  const prior = saved.find((record) => record.id === target.id);
  if (prior === undefined) {
    return {
      ok: false,
      error: {
        code: "unknown-unit",
        detail: `no saved unit \`${target.id}\`; bind \`new=true\` for a fresh ID`,
      },
    };
  }
  if (prior.source.kind !== request.source.kind) {
    return {
      ok: false,
      error: {
        code: "kind-mismatch",
        detail:
          `saved unit \`${prior.id}\` is a ${prior.source.kind} group, not ${request.source.kind};` +
          " bind a same-kind ID or `new=true`",
      },
    };
  }
  return {
    ok: true,
    record: {
      abi_version: UNIT_ABI_VERSION,
      id: prior.id,
      source: { ...request.source, revision: currentRevision },
      contract: request.contract,
      original: prior.original,
      provenance: prior.provenance,
    },
  };
}
