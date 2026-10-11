import { describe, expect, it, vi } from "vitest";
import {
  applyUpgrade,
  manualApplyCommand,
  runWranglerDeploy,
  type WranglerSpawner,
} from "../src/upgrade/apply.js";

const upgradePlan = {
  from: [{ owner: "teamtasks", snapshotId: "snap-1" }],
  to: {
    appName: "TeamTasks",
    sourceRevision: "14fa6a0",
    languageVersion: "1.0.0",
    compilerVersion: "0.1.0",
    contractsVersion: 1,
    artifactDigest: "digest-fixture",
  },
  pendingWork: [],
};

describe("wrangler deploy backend (P-B)", () => {
  it("refuses to spawn without explicit yes, naming the manual apply", () => {
    const spawn = vi.fn();
    expect(() =>
      runWranglerDeploy({ yes: false, configPath: "/tmp/x.wrangler.toml", spawn }),
    ).toThrow(/--yes/);
    try {
      runWranglerDeploy({ yes: false, configPath: "/tmp/x.wrangler.toml", spawn });
    } catch (error) {
      expect((error as Error).message).toContain("wrangler deploy --config");
      expect((error as Error).message).toContain("nothing was applied");
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("yes spawns wrangler deploy --config and reports applied on status 0", () => {
    const spawn: WranglerSpawner = vi.fn(() => ({ status: 0, stdout: "uploaded", stderr: "" }));
    const result = runWranglerDeploy({
      yes: true,
      configPath: "/tmp/x.wrangler.toml",
      workingDir: "/tmp",
      spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("wrangler", ["deploy", "--config", "/tmp/x.wrangler.toml"], {
      cwd: "/tmp",
    });
    expect(result.applied).toBe(true);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("uploaded");
  });

  it("nonzero status reports applied:false with captured output (no throw)", () => {
    const spawn: WranglerSpawner = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "auth failed",
    }));
    const result = runWranglerDeploy({ yes: true, configPath: "/tmp/x.wrangler.toml", spawn });
    expect(result.applied).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("auth failed");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.manualApply).toContain("wrangler deploy --config");
  });

  it.each(["ENOENT", "ETIMEDOUT"])("spawn failure %s reports an unconfirmed outcome without retry", (code) => {
    const spawn = vi.fn<WranglerSpawner>(() => {
      throw Object.assign(new Error(`spawn wrangler ${code}`), { code });
    });
    let failure: unknown;
    try {
      runWranglerDeploy({ yes: true, configPath: "/tmp/x.wrangler.toml", spawn });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(code);
    expect(message).toContain("remote outcome unconfirmed");
    expect(message).toContain("Inspect the deployment before any manual retry");
    expect(message).toContain('wrangler deploy --config "/tmp/x.wrangler.toml"');
    expect(message).not.toContain("no deploy was performed");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("manualApplyCommand names the exact by-hand equivalent", () => {
    expect(manualApplyCommand("/tmp/x.wrangler.toml")).toBe(
      'wrangler deploy --config "/tmp/x.wrangler.toml"',
    );
  });
});

describe("upgrade apply live path (P-B)", () => {
  it("dry-run stays the default: rehearsed stages, no spawn option needed", () => {
    const result = applyUpgrade(upgradePlan);
    expect(result.dryRun).toBe(true);
    expect(result.states.map((state) => state.stage)).toEqual([
      "proposed",
      "admissions-closed",
      "staging",
      "staged",
      "activating",
      "active",
    ]);
  });

  it("live applyUpgrade still refuses (store backend out of scope), naming manual apply", () => {
    expect(() => applyUpgrade(upgradePlan, { dryRun: false })).toThrow(/wrangler/i);
    try {
      applyUpgrade(upgradePlan, { dryRun: false });
      expect.unreachable("live applyUpgrade must refuse");
    } catch (error) {
      expect((error as Error).message).toContain("wrangler deploy --config");
      expect((error as Error).message.toLowerCase()).toContain("nothing was applied");
    }
  });
});
