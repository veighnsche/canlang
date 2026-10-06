/**
 * T37 basic pilot, direct legs (LG03): ONE unchanged original app —
 * `draft/CanDo.can` plus its minimal shared closure
 * (`draft/shared/Locations.can`, `draft/shared/Employees.can`) — proves
 * generated operations, two actors, denied read, persistence, stale
 * update, replay, `complete`/`reopen` scenarios, and genuine executed
 * examples. No reduced source projection: every input is hashed committed
 * bytes and the pilot stays first so `sources[0]` identity binds CanDo.
 *
 * Journeys invoke the REAL canonical invoker against REAL miniflare D1
 * (the T21 island); identity is the REAL L6 memory store (same
 * durable-claim scope as T21). Served legs (browser page GETs + MCP
 * tools/call over the C1 deploy bundle) ride a follow-up slice: worker
 * identity/env provisioning cannot be built blind and needs the same
 * runtime the T02 blockers gate.
 *
 * Presence-shaped assertions (own rows only): the island D1 is per
 * Playwright *worker*, shared across compiled specs in that worker.
 *
 * Leg bodies live in `./pilot-legs.ts`, shared with the patched live
 * runs (`challenge-pilot-patched.spec.ts`, suite-3 fixtures). This file
 * stays the pristine witness: while the draft carries the adjudicated
 * rejections it fails loud in the `compiled` fixture, proving the
 * owning-lane restructures are still needed.
 */
import { compiledTest as base } from "../fixtures/e2e-test.js";
import {
  disposeCompiledAssembly,
  loadCompiledArtifact,
} from "../fixtures/artifact-loader.js";
import { pilotLegs, type PilotLegSources } from "./pilot-legs.js";

export const PILOT_SOURCE = "draft/CanDo.can";
export const PILOT_EXTRA_SOURCES = ["draft/shared/Locations.can", "draft/shared/Employees.can"];

const SOURCES: PilotLegSources = { source: PILOT_SOURCE, extraSources: PILOT_EXTRA_SOURCES };

/** Pilot `compiled` fixture: CanDo + minimal closure (island inherited). */
export const pilotTest = base.extend({
  compiled: [
    async ({}, use) => {
      const compiled = await loadCompiledArtifact({
        kind: "compiled",
        source: PILOT_SOURCE,
        extraSources: PILOT_EXTRA_SOURCES,
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

pilotTest.describe("challenge pilot", () => {
  for (const leg of pilotLegs) {
    pilotTest(leg.name, async ({ compiled, island }) => {
      await leg.run({ compiled, island }, SOURCES);
    });
  }
});
