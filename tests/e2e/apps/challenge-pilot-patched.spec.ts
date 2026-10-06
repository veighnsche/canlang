/**
 * T37 basic pilot against the suite-3 patched fixtures
 * (`../fixtures/patched-pilot/`): the same 7 legs as
 * `challenge-pilot.spec.ts` (shared `./pilot-legs.ts`, no drift), compiled
 * over exact-site patches for the 3 adjudicated sites (CanDo:44 guard,
 * Employees:8,9 pure derives; base draft `40656da`). The authoritative
 * draft stays pristine; provenance (pins, diff, verdict cites) lives in
 * `../fixtures/patched-pilot/PROVENANCE.md`.
 *
 * The FIRST test re-proves provenance on every run: pristine bytes must
 * match the pinned `40656da` hashes (drift guard — a moved draft fails
 * loud demanding re-pin), and the patched/pristine diff must sit EXACTLY
 * inside the 3 adjudicated sites. It uses no `compiled`/`island`
 * fixtures, so it runs before the toolchain burns any time.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { compiledTest as base } from "../fixtures/e2e-test.js";
import {
  disposeCompiledAssembly,
  loadCompiledArtifact,
} from "../fixtures/artifact-loader.js";
import { pilotLegs, type PilotLegSources } from "./pilot-legs.js";

export const PATCHED_PILOT_SOURCE = "tests/e2e/fixtures/patched-pilot/CanDo.can";
export const PATCHED_PILOT_EXTRA_SOURCES = [
  "tests/e2e/fixtures/patched-pilot/Locations.can",
  "tests/e2e/fixtures/patched-pilot/Employees.can",
];

const SOURCES: PilotLegSources = {
  source: PATCHED_PILOT_SOURCE,
  extraSources: PATCHED_PILOT_EXTRA_SOURCES,
};

/** Patched `compiled` fixture: patched CanDo + patched closure. */
export const patchedPilotTest = base.extend({
  compiled: [
    async ({}, use) => {
      const compiled = await loadCompiledArtifact({
        kind: "compiled",
        source: PATCHED_PILOT_SOURCE,
        extraSources: PATCHED_PILOT_EXTRA_SOURCES,
      });
      try {
        await use(compiled);
      } finally {
        disposeCompiledAssembly(compiled);
      }
    },
    { scope: "worker" },
  ],
});

interface PristinePin {
  /** Repo-relative pristine path (`draft/**`, submodule pin `40656da`). */
  readonly pristine: string;
  /** Repo-relative patched copy under `patched-pilot/`. */
  readonly patched: string;
  /** Pinned sha256 of the pristine bytes (PROVENANCE.md). */
  readonly sha256: string;
  /**
   * Exact 1-based inclusive line ranges (pristine numbering) allowed to
   * differ. Empty = byte-identical. Single-hunk prefix/suffix trim is
   * fail-closed: scattered edits yield one spanning hunk that matches
   * no pin below.
   */
  readonly hunks: ReadonlyArray<{ readonly first: number; readonly last: number }>;
  /** Exact expected patched lines, keyed by 1-based patched line number. */
  readonly patchedLines: Readonly<Record<number, string>>;
}

const PRISTINE_PINS: readonly PristinePin[] = [
  {
    pristine: "draft/CanDo.can",
    patched: "tests/e2e/fixtures/patched-pilot/CanDo.can",
    sha256: "15761cc422c6d11827a6f13aa3cc3318a8bb393ef2110169f1a02ff046e4ec35",
    hunks: [{ first: 44, last: 44 }],
    patchedLines: {
      44: "  invariant preferences: actor==null or (row.location==null or can_work(actor,row.location))",
    },
  },
  {
    pristine: "draft/shared/Locations.can",
    patched: "tests/e2e/fixtures/patched-pilot/Locations.can",
    sha256: "6cafeb02349c80c8ff19a278bc9072258fe8b8f402409629fed534854e106c7a",
    hunks: [],
    patchedLines: {},
  },
  {
    pristine: "draft/shared/Employees.can",
    patched: "tests/e2e/fixtures/patched-pilot/Employees.can",
    sha256: "64b941f4e3db0afe499903642585e362482d6aa39f679b3b1e688dc912d3b7f4",
    hunks: [{ first: 8, last: 9 }],
    patchedLines: {
      8: "  export derive staff(person:user):bool = any(Employee as e,e.user==person and e.active)",
      9: "  export derive can_work(person:user,location:Location):bool = any(Employee as e,e.user==person and e.active and (e.operator_wide or e.home==location or location in e.locations))",
    },
  },
];

function sha256Hex(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

/**
 * Prefix/suffix-trim line diff. Returns the single spanning hunk when
 * the files differ (fail-closed for scattered edits: the span matches
 * no exact pin), or [] when byte-identical.
 */
function diffHunk(
  pristineLines: readonly string[],
  patchedLines: readonly string[],
): Array<{ first: number; last: number }> {
  let prefix = 0;
  while (
    prefix < pristineLines.length &&
    prefix < patchedLines.length &&
    pristineLines[prefix] === patchedLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < pristineLines.length - prefix &&
    suffix < patchedLines.length - prefix &&
    pristineLines[pristineLines.length - 1 - suffix] ===
      patchedLines[patchedLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (prefix + suffix === pristineLines.length && prefix + suffix === patchedLines.length) {
    return [];
  }
  return [{ first: prefix + 1, last: pristineLines.length - suffix }];
}

patchedPilotTest.describe("challenge pilot (patched fixtures)", () => {
  patchedPilotTest(
    "patched fixtures differ from pristine only at the 3 adjudicated sites",
    async () => {
      const root = fileURLToPath(new URL("../../../", import.meta.url));
      expect(PRISTINE_PINS.length).toBe(3);
      for (const pin of PRISTINE_PINS) {
        const pristineBytes = readFileSync(`${root}${pin.pristine}`, "utf8");
        expect(sha256Hex(pristineBytes), `${pin.pristine} drifted off 40656da: re-pin`).toBe(
          pin.sha256,
        );
        const patchedBytes = readFileSync(`${root}${pin.patched}`, "utf8");
        const hunks = diffHunk(pristineBytes.split("\n"), patchedBytes.split("\n"));
        expect(
          hunks,
          `${pin.patched} diff must sit exactly inside the adjudicated sites`,
        ).toEqual(pin.hunks);
        const patchedLines = patchedBytes.split("\n");
        for (const [line, expected] of Object.entries(pin.patchedLines)) {
          expect(patchedLines[Number(line) - 1], `${pin.patched}:${line}`).toBe(expected);
        }
      }
    },
  );

  for (const leg of pilotLegs) {
    patchedPilotTest(leg.name, async ({ compiled, island }) => {
      await leg.run({ compiled, island }, SOURCES);
    });
  }
});
