import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupAcceptanceBrowsers, type AcceptanceCleanupControl } from "./acceptance-cleanup.js";

const session = "a".repeat(48);
const app = "Probe";
const unavailable = (command: string, detail = "No such file or directory (os error 2)") => ({
  code: 1, stdout: JSON.stringify({ ok: false, command, code: "CONTROL_IO", detail }),
});
const present = { code: 0, stdout: JSON.stringify({ ok: true, command: "discover", session }) };
const stopped = { code: 0, stdout: JSON.stringify({ ok: true, command: "stop", session, result: { stopped: true } }) };

async function fixture(): Promise<{ root: string; output: string; source: string; owner: string }> {
  const root = await mkdtemp(join(tmpdir(), "can-browser-cleanup-"));
  const output = join(root, "output"), source = join(root, "candidate/Probe.can");
  await mkdir(output);
  const owner = join(output, `browser-owner-${session}.json`);
  await writeFile(owner, JSON.stringify({ workspace: root, source, session, app, owned: true }));
  return { root, output, source, owner };
}

test("browser cleanup stops only its exact owner and verifies absence after acknowledgement", async () => {
  const f = await fixture();
  try {
    const calls: string[][] = [];
    const control: AcceptanceCleanupControl = async (args, workspace) => {
      assert.equal(workspace, f.root);
      assert.deepEqual(args.slice(1), ["--root", f.root, "--session", session, "--app", app, "--profile", "local-d1-identity"]);
      calls.push(args);
      return calls.length === 1 ? present : args[0] === "stop" ? stopped : unavailable("discover");
    };
    // An unrelated nested output is not part of this invocation's owner records.
    await mkdir(join(f.output, "other"));
    await writeFile(join(f.output, "other/browser-owner-foreign.json"), "invalid");
    await cleanupAcceptanceBrowsers(f.output, f.root, f.source, control);
    assert.deepEqual(calls.map(args => args[0]), ["discover", "stop", "discover"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("browser cleanup accepts an already absent endpoint without stopping", async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    await cleanupAcceptanceBrowsers(f.output, f.root, f.source, async args => {
      calls.push(args[0]!);
      return unavailable("discover");
    });
    assert.deepEqual(calls, ["discover"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const altered of ["workspace", "source", "session", "app", "owned"] as const) {
  test(`browser cleanup refuses an invalid ${altered} without contacting any session`, async () => {
    const f = await fixture();
    try {
      const record = { workspace: f.root, source: f.source, session, app, owned: true };
      await writeFile(f.owner, JSON.stringify({ ...record, [altered]: altered === "owned" ? false : altered === "app" ? "not an app" : "foreign" }));
      let calls = 0;
      await assert.rejects(cleanupAcceptanceBrowsers(f.output, f.root, f.source, async () => {
        calls += 1;
        return present;
      }), /owner record does not match/);
      assert.equal(calls, 0);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

for (const final of [present, unavailable("discover", "Connection refused (os error 61)"),
  unavailable("discover", "ENOENT mentioned in another error"),
  unavailable("discover", "Permission denied (os error 13)"),
  { code: 1, stdout: JSON.stringify({ ok: false, command: "discover", code: "CONTROL_UNAVAILABLE", detail: "ENOENT: endpoint absent" }) },
  { code: 1, stdout: JSON.stringify({ ok: false, command: "discover", code: "SESSION_MISMATCH", detail: "ENOENT" }) }]) {
  test(`browser cleanup refuses stop acknowledgement without verified absence: ${final.stdout}`, async () => {
    const f = await fixture();
    try {
      let calls = 0;
      await assert.rejects(cleanupAcceptanceBrowsers(f.output, f.root, f.source, async args => {
        calls += 1;
        return calls === 1 ? present : args[0] === "stop" ? stopped : final;
      }), /browser cleanup failed/);
      assert.equal(calls, 3);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test("browser cleanup accepts verified absence after a stop exception", async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    await cleanupAcceptanceBrowsers(f.output, f.root, f.source, async args => {
      calls.push(args[0]!);
      if (args[0] === "stop") throw new Error("process timeout");
      return calls.length === 1 ? present : unavailable("discover");
    });
    assert.deepEqual(calls, ["discover", "stop", "discover"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("browser cleanup refuses a stop exception when absence is not proved", async () => {
  const f = await fixture();
  try {
    const calls: string[] = [];
    await assert.rejects(cleanupAcceptanceBrowsers(f.output, f.root, f.source, async args => {
      calls.push(args[0]!);
      if (args[0] === "stop") throw new Error("process timeout");
      return present;
    }), /browser cleanup failed/);
    assert.deepEqual(calls, ["discover", "stop", "discover"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
