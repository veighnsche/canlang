import { expect, it } from "vitest";
import { runDevControlArgv } from "../src/dev/control-client.js";
import { SessionSocketError, SESSION_SOCKET_PROTOCOL, type SessionSocketClient } from "../src/dev/session-socket.js";

const owner: SessionSocketClient = {
  identity: {
    protocol: SESSION_SOCKET_PROTOCOL, root: "/repo", app: "Office", profile: "local-single-file",
    sessionId: "s1", pid: 1, uid: 1, processStart: "p1", socketPath: "/tmp/s1",
  },
  request: async command => command,
};

it("provides machine-readable control help without attaching to a session", async () => {
  const result = await runDevControlArgv(["help"], {
    cwd: "/repo", discover: async () => { throw new Error("unexpected discovery"); },
  });
  expect(result).toMatchObject({ ok: true, command: "help", session: null });
  expect(JSON.stringify(result)).toContain("example.rerun");
});

it("pins diagnostic lookups and passes source errors as successful control responses", async () => {
  const lookups: unknown[] = [];
  const discover = async (lookup: unknown): Promise<SessionSocketClient> => {
    lookups.push(lookup);
    return { ...owner, request: async command => command.command === "check"
      ? { state: "errors", focus: { code: "E1200" } } : command };
  };
  expect(await runDevControlArgv(["diagnostic.detail", "--root", "/repo", "--session", "s1", "--revision", "r2", "--index", "3"], {
    cwd: "/other", discover,
  })).toMatchObject({
    ok: true, session: "s1", result: { command: "diagnostic.detail", payload: { revision: "r2", index: 3 } },
  });
  expect(lookups).toEqual([{ checkoutRoot: "/repo", sessionId: "s1" }]);
  expect(await runDevControlArgv(["check", "--expected-revision", "r2"], { cwd: "/repo", discover })).toMatchObject({
    ok: true, result: { state: "errors", focus: { code: "E1200" } },
  });
  expect(await runDevControlArgv(["failure.lookup", "--ref", "s1/r2/d0"], { cwd: "/repo", discover })).toMatchObject({
    ok: true, result: { command: "failure.lookup", payload: { ref: "s1/r2/d0" } },
  });
});

it("refuses invalid queries before socket access and surfaces owner mismatch", async () => {
  let calls = 0;
  const discover = async (): Promise<SessionSocketClient> => { calls++; return owner; };
  expect(await runDevControlArgv(["diagnostics"], { cwd: "/repo", discover })).toMatchObject({ ok: false, code: "REVISION_REQUIRED" });
  expect(await runDevControlArgv(["diagnostics", "--revision", "r1", "--limit", "100"], { cwd: "/repo", discover })).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
  expect(await runDevControlArgv(["preview.open", "--index", "0"], { cwd: "/repo", discover })).toMatchObject({ ok: false, code: "INVALID_ARGUMENTS" });
  expect(await runDevControlArgv(["failure.detail"], { cwd: "/repo", discover })).toMatchObject({ ok: false, code: "FAILURE_REF_REQUIRED" });
  expect(calls).toBe(0);
  const mismatched = await runDevControlArgv(["status", "--session", "foreign"], {
    cwd: "/repo", discover: async () => { throw new SessionSocketError("SESSION_MISMATCH", "wrong session"); },
  });
  expect(mismatched).toEqual({ ok: false, command: "status", code: "SESSION_MISMATCH", detail: "wrong session" });
});
