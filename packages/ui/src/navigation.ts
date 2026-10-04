/**
 * Pure navigation discovery shaping (lane 05 S2).
 *
 * The lane 6 dispatcher owns admission: it calls `admit` per candidate and
 * supplies one {@link AdmissionOutcome} per candidate. This module only shapes
 * those results into sorted, grouped navigation. No I/O, no `admit` calls.
 */

import type {
  AdmissionOutcome,
  MessageValue,
  NavigationEntry,
  NavigationGroup,
  NavigationResult,
  OwnerLabels,
  PageDescriptor,
} from "../../contracts/src/presentation.js";

/**
 * Filter declaration-order descriptors down to discovery candidates:
 * drop `nav="none"` pages, drop dynamic routes (path contains "{"), and
 * dedup exact (owner, path) pairs keeping the first occurrence.
 */
export function selectDiscoveryCandidates(
  descriptors: readonly PageDescriptor[],
): PageDescriptor[] {
  const seen = new Set<string>();
  const candidates: PageDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.nav === "none") {
      continue;
    }
    if (descriptor.path.includes("{")) {
      continue;
    }
    const key = JSON.stringify([descriptor.owner, descriptor.path]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(descriptor);
  }
  return candidates;
}

export interface BuildNavigationOptions {
  readonly ownerLabels: OwnerLabels;
  readonly currentPath: string;
  readonly highlightPath?: string;
}

interface AdmittedRecord {
  readonly descriptor: PageDescriptor;
  /** Position in the candidates array (declaration order). */
  readonly index: number;
  readonly order: bigint;
}

/** Static identity of an explicit group: the string itself, or source text. */
function groupIdentity(group: MessageValue): string {
  return typeof group === "string" ? group : group.source;
}

interface GroupAccumulator {
  readonly owner: string;
  readonly explicit: boolean;
  readonly records: AdmittedRecord[];
}

/**
 * Shape admitted candidates into grouped navigation.
 *
 * @throws Error when a candidate has no outcome (dispatcher bug: fail closed).
 */
export function buildNavigation(
  candidates: readonly PageDescriptor[],
  outcomes: ReadonlyMap<PageDescriptor, AdmissionOutcome>,
  options: BuildNavigationOptions,
): NavigationResult {
  const highlight = options.highlightPath ?? options.currentPath;
  let incomplete = false;
  const admitted: AdmittedRecord[] = [];
  candidates.forEach((candidate, index) => {
    const outcome = outcomes.get(candidate);
    if (outcome === undefined) {
      throw new Error(
        `missing admission outcome for candidate ${candidate.owner} ${candidate.path}`,
      );
    }
    if (outcome === "unavailable") {
      incomplete = true;
    }
    if (outcome !== "admitted") {
      return;
    }
    admitted.push({ descriptor: candidate, index, order: candidate.order ?? 0n });
  });
  admitted.sort((a, b) => {
    if (a.order < b.order) {
      return -1;
    }
    if (a.order > b.order) {
      return 1;
    }
    return a.index - b.index;
  });

  // One group stream per owner; within an owner, explicit groups cluster by
  // static identity and group-less entries share the default group. Groups
  // are created in sorted-entry order, so creation order already equals
  // first-entry-sorted-position order.
  const groups = new Map<string, GroupAccumulator>();
  for (const record of admitted) {
    const group = record.descriptor.group;
    const key =
      group === undefined
        ? JSON.stringify([record.descriptor.owner, "default"])
        : JSON.stringify([record.descriptor.owner, "explicit", groupIdentity(group)]);
    let accumulator = groups.get(key);
    if (accumulator === undefined) {
      accumulator = { owner: record.descriptor.owner, explicit: group !== undefined, records: [] };
      groups.set(key, accumulator);
    }
    accumulator.records.push(record);
  }

  const result: NavigationGroup[] = [];
  for (const accumulator of groups.values()) {
    if (accumulator.records.length === 0) {
      continue;
    }
    const first = accumulator.records[0];
    if (first === undefined) {
      continue;
    }
    let caption: MessageValue;
    if (accumulator.explicit) {
      const group = first.descriptor.group;
      if (group === undefined) {
        continue;
      }
      caption = group;
    } else {
      const label = options.ownerLabels.get(accumulator.owner);
      if (label !== undefined) {
        caption = label;
      } else {
        // First-declared (input order) admitted default-group entry's title.
        // Only admitted default-group records exist here, so denied,
        // unavailable, and hidden pages can never supply the fallback.
        let earliest = first;
        for (const record of accumulator.records) {
          if (record.index < earliest.index) {
            earliest = record;
          }
        }
        caption = earliest.descriptor.title;
      }
    }
    const entries: NavigationEntry[] = accumulator.records.map((record) => {
      const active = record.descriptor.path === highlight;
      const description = record.descriptor.description;
      if (description === undefined) {
        return {
          owner: record.descriptor.owner,
          path: record.descriptor.path,
          title: record.descriptor.title,
          active,
        };
      }
      return {
        owner: record.descriptor.owner,
        path: record.descriptor.path,
        title: record.descriptor.title,
        description,
        active,
      };
    });
    result.push({ owner: accumulator.owner, caption, entries });
  }
  return { groups: result, incomplete };
}
