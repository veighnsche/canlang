/**
 * B3-I6 installed-runtime probe tests (`src/deploy/installed.ts`).
 *
 * Failing-first: this suite was written before the module existed.
 */
import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION } from "@canlang/contracts";
import {
  KNOWN_CAPABILITIES,
  probeInstalledRuntime,
  splitCapabilities,
  type ProbeInstalledRuntimeOptions,
} from "../src/deploy/installed.js";

function probeOptions(overrides: Partial<ProbeInstalledRuntimeOptions> = {}): ProbeInstalledRuntimeOptions {
  return {
    contractsVersion: CONTRACTS_VERSION,
    runtimeVersion: "probe-fixture/0",
    knownLanguageVersions: ["1.0.0"],
    capabilities: ["d1-batch", "state"],
    supportsSchedules: false,
    ...overrides,
  };
}

describe("KNOWN_CAPABILITIES registry", () => {
  it("covers the compiler-emitted requires vocabulary plus infra capabilities", () => {
    for (const id of [
      "canlang.builtins",
      "values.decimal",
      "values.int64",
      "values.money",
      "values.temporal",
      "state",
      "d1-batch",
      "do-alarms",
    ]) {
      expect(KNOWN_CAPABILITIES).toContain(id);
    }
  });
});

describe("splitCapabilities (known-vs-installed split)", () => {
  it("splits known-installed, known-missing, and unknown ids", () => {
    expect(splitCapabilities(["d1-batch", "do-alarms"], ["d1-batch", "teleport.v1"])).toEqual({
      installed: ["d1-batch"],
      missing: ["do-alarms"],
      unknown: ["teleport.v1"],
    });
  });
});

describe("probeInstalledRuntime", () => {
  it("builds the InstalledRuntime struct from the declared target", () => {
    const installed = probeInstalledRuntime({}, probeOptions());
    expect(installed).toEqual({
      contractsVersion: CONTRACTS_VERSION,
      runtimeVersion: "probe-fixture/0",
      capabilities: ["d1-batch", "state"],
      knownLanguageVersions: ["1.0.0"],
      supportsSchedules: false,
    });
  });

  it("fails loud on unknown capability ids (deployment bug, never a verdict)", () => {
    expect(() =>
      probeInstalledRuntime({}, probeOptions({ capabilities: ["d1-batch", "teleport.v1"] })),
    ).toThrow(/unknown capability.*teleport\.v1/);
  });

  it("rejects a non-record env", () => {
    expect(() => probeInstalledRuntime(null as unknown as Record<string, unknown>, probeOptions())).toThrow(
      TypeError,
    );
  });
});
