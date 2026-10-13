/**
 * Conservative generation-unit association (BGI-02): unique matching of
 * discovered units to saved records, opaque ID allocation, and explicit
 * bind/copy reconciliation.
 *
 * Association evidence is exactly owner/kind/label/normalized-structure.
 * A prompt-only change preserves the ID while the non-prompt anchor is
 * unchanged and unique. Identity is never inferred from a sole unmatched
 * old/new pair, nearest offset, or prompt similarity: ambiguous moves,
 * copies, or renames diagnose and require explicit `bind`. This module is
 * pure (no filesystem); `records.ts` owns saved-group intake.
 */

import type {
  GenerationUnitId,
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
 * Conservatively associate discovered units with saved records. A
 * descriptor retains its ID only when its key is unique on both sides
 * and exactly one saved record matches. Copies (duplicate keys on the
 * descriptor side) and duplicate saved records both refuse; relocated
 * units whose anchor changed are `new` rather than silently reusing
 * ownership.
 *
 * The one exception honors an explicit bind: when a descriptor carries
 * its current `location` and exactly one same-key record captured that
 * exact source revision/location, the descriptor retains that record's
 * ID. Changed or stale source never guesses: a revision or span that no
 * longer matches refuses as before, as do two records claiming the same
 * location.
 */
export function associate(
  descriptors: readonly DescriptorInput[],
  saved: readonly UnitRecord[],
): Array<{ index: number; association: UnitAssociation }> {
  const savedByKey = new Map<string, UnitRecord[]>();
  for (const record of saved) {
    const text = keyText(keyOfSource(record.source));
    const group = savedByKey.get(text);
    if (group !== undefined) {
      group.push(record);
    } else {
      savedByKey.set(text, [record]);
    }
  }
  const keyCounts = new Map<string, number>();
  const keyed: Array<{ index: number; key: string }> = [];
  descriptors.forEach((descriptor, index) => {
    const text = keyText(keyOfDescriptor(descriptor));
    keyCounts.set(text, (keyCounts.get(text) ?? 0) + 1);
    keyed.push({ index, key: text });
  });
  return keyed.map(({ index, key }) => {
    const descriptor = descriptors[index] as DescriptorInput;
    let association: UnitAssociation;
    if ((keyCounts.get(key) ?? 0) > 1) {
      // A copied definition shares its whole key: refuse reuse, unless
      // an explicit bind captured this exact location.
      const group = savedByKey.get(key) ?? [];
      const bound = boundMatch(group, descriptor.location);
      association =
        bound !== null
          ? retained(descriptor, bound)
          : { type: "ambiguous", candidates: group.map((record) => record.id).sort() };
    } else {
      const group = savedByKey.get(key);
      if (group === undefined) {
        association = { type: "new" };
      } else if (group.length === 1) {
        const only = group[0] as UnitRecord;
        association = retained(descriptor, only);
      } else {
        // Duplicate saved records: refuse to pick one, unless an
        // explicit bind captured this exact location.
        const bound = boundMatch(group, descriptor.location);
        association =
          bound !== null
            ? retained(descriptor, bound)
            : { type: "ambiguous", candidates: group.map((record) => record.id).sort() };
      }
    }
    return { index, association };
  });
}

/**
 * Allocate the smallest fresh `u<N>` ID outside `used`. Sequential
 * allocation keeps IDs opaque (no meaning) and deterministic under tests.
 * Lease-coordinated allocation across writers is BGI-04's protocol.
 */
export function nextUnitId(used: ReadonlySet<string> | readonly string[]): GenerationUnitId {
  const taken = used instanceof Set ? used : new Set(used);
  let n = 1;
  while (taken.has(`u${n}`)) {
    n += 1;
  }
  return `u${n}`;
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
