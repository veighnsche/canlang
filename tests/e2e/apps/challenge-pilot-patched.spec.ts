/** Canonical mutation and authored-example journeys against the isolated pilot fixture closure. */
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

patchedPilotTest.describe("challenge pilot (patched fixtures)", () => {
  for (const leg of pilotLegs) {
    patchedPilotTest(leg.name, async ({ compiled, island }, testInfo) => {
      if (leg.timeoutMs !== undefined) testInfo.setTimeout(leg.timeoutMs);
      await leg.run({ compiled, island }, SOURCES);
    });
  }
});
