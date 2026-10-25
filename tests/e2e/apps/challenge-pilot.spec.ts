/**
 * Original CanDo + its unchanged shared source closure, compiled by the real
 * compiler and exercised against real D1. These journeys cover authored
 * guards, row visibility, mutation receipts, replay and fixture examples.
 * The examples use the production runner with real D1 Identity provisioning;
 * direct mutation legs use the isolated Identity memory fixture.
 */
import { compiledTest as base } from "../fixtures/e2e-test.js";
import {
  disposeCompiledAssembly,
  loadCompiledArtifact,
} from "../fixtures/artifact-loader.js";
import { pilotLegs, type PilotLegSources } from "./pilot-legs.js";

export const PILOT_SOURCE = "draft/apps/CanDo/CanDo.can";
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
    pilotTest(leg.name, async ({ compiled, island }, testInfo) => {
      if (leg.timeoutMs !== undefined) testInfo.setTimeout(leg.timeoutMs);
      await leg.run({ compiled, island }, SOURCES);
    });
  }
});
