import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  discoverSessionSocket,
  SessionSocketError,
  startSessionSocket,
} from "./session-socket.js";

async function fixture(): Promise<{ scratch: string; root: string; runtimeDir: string }> {
  const scratch = await mkdtemp(join(tmpdir(), "cv-"));
  const root = join(scratch, "c");
  const runtimeDir = join(scratch, "r");
  await mkdir(root, { mode: 0o700 });
  await mkdir(runtimeDir, { mode: 0o700 });
  return { scratch, root, runtimeDir };
}

function codeIs(expected: string): (error: unknown) => boolean {
  return error => error instanceof SessionSocketError && error.code === expected;
}

test("owner-only socket attaches only to the selected canonical session", async () => {
  const { scratch, root, runtimeDir } = await fixture();
  const alias = join(scratch, "alias");
  await symlink(root, alias);
  const owner = await startSessionSocket({
    checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: command => ({ command: command.command, payload: command.payload }),
  });
  try {
    const client = await discoverSessionSocket({ checkoutRoot: alias, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir });
    assert.equal(client.identity.root, await realpath(root));
    assert.equal(client.identity.sessionId, owner.identity.sessionId);
    assert.deepEqual(await client.request({ command: "status", payload: { page: 1 } }), { command: "status", payload: { page: 1 } });
    await assert.rejects(startSessionSocket({
      checkoutRoot: alias, app: "Other", profile: "local-d1-identity", runtimeDir,
      handle: () => null,
    }), codeIs("SESSION_EXISTS"));
    await assert.rejects(discoverSessionSocket({ checkoutRoot: root, app: "Other", runtimeDir }), codeIs("SESSION_MISMATCH"));
    await assert.rejects(discoverSessionSocket({ checkoutRoot: root, sessionId: "wrong", runtimeDir }), codeIs("SESSION_MISMATCH"));
    assert.equal((await lstat(runtimeDir)).mode & 0o077, 0);
    assert.equal((await lstat(dirname(owner.descriptorPath))).mode & 0o077, 0);
    assert.equal((await lstat(owner.descriptorPath)).mode & 0o077, 0);
    assert.equal((await lstat(owner.identity.socketPath)).mode & 0o077, 0);
    await chmod(owner.descriptorPath, 0o644);
    await assert.rejects(discoverSessionSocket({ checkoutRoot: root, runtimeDir }), codeIs("INSECURE_ENDPOINT"));
    await chmod(owner.descriptorPath, 0o600);
    await owner.stop();
    await assert.rejects(client.request({ command: "status" }));
  } finally {
    await owner.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("separate worktrees cannot attach to each other's owner or data channel", async () => {
  const { scratch, root, runtimeDir } = await fixture();
  const secondRoot = join(scratch, "other-checkout");
  await mkdir(secondRoot, { mode: 0o700 });
  const first = await startSessionSocket({
    checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: () => "first",
  });
  const second = await startSessionSocket({
    checkoutRoot: secondRoot, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: () => "second",
  });
  try {
    assert.notEqual(first.identity.socketPath, second.identity.socketPath);
    assert.notEqual(first.identity.sessionId, second.identity.sessionId);
    assert.equal(await (await discoverSessionSocket({ checkoutRoot: root, runtimeDir })).request({ command: "status" }), "first");
    assert.equal(await (await discoverSessionSocket({ checkoutRoot: secondRoot, runtimeDir })).request({ command: "status" }), "second");
    const forged = JSON.parse(await readFile(second.descriptorPath, "utf8")) as Record<string, unknown>;
    forged.socketPath = first.identity.socketPath;
    await writeFile(second.descriptorPath, JSON.stringify(forged), { mode: 0o600 });
    await assert.rejects(discoverSessionSocket({ checkoutRoot: secondRoot, runtimeDir }), codeIs("INVALID_DESCRIPTOR"));
  } finally {
    await first.stop();
    await second.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a dead owner's descriptor is reclaimed without accepting its old session", async () => {
  const { scratch, root, runtimeDir } = await fixture();
  const moduleUrl = new URL("./session-socket.js", import.meta.url).href;
  const childCode = `import { startSessionSocket } from ${JSON.stringify(moduleUrl)}; await startSessionSocket({checkoutRoot:process.argv[1],app:"OfficeSupplies",profile:"local-d1-identity",runtimeDir:process.argv[2],handle:()=>null}); process.stdout.write("ready\\n",()=>process.exit(0));`;
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, root, runtimeDir], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
    const exit = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", code => resolveExit(code));
    });
    assert.equal(exit, 0, errors);
    assert.match(output, /ready/);
    const owner = await startSessionSocket({
      checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
      handle: () => "recovered",
    });
    try {
      assert.equal(await (await discoverSessionSocket({ checkoutRoot: root, runtimeDir })).request({ command: "status" }), "recovered");
    } finally {
      await owner.stop();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a crashed recovery lock and an abandoned incomplete lock can be reclaimed", async () => {
  const { scratch, root, runtimeDir } = await fixture();
  const first = await startSessionSocket({
    checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: () => null,
  });
  const sessionDir = dirname(first.descriptorPath);
  const claim = JSON.parse(await readFile(join(sessionDir, "claim.json"), "utf8")) as Record<string, unknown>;
  await first.stop();
  try {
    await mkdir(sessionDir, { mode: 0o700 });
    await writeFile(join(sessionDir, "claim.json"), JSON.stringify({ ...claim, pid: 2_147_483_647 }), { mode: 0o600 });
    const recoveryPath = `${sessionDir}.recover`;
    await mkdir(recoveryPath, { mode: 0o700 });
    await writeFile(join(recoveryPath, "owner.json"), JSON.stringify({ ...claim, pid: 2_147_483_647 }), { mode: 0o600 });
    const second = await startSessionSocket({
      checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
      handle: () => "recovered",
    });
    assert.equal(await (await discoverSessionSocket({ checkoutRoot: root, runtimeDir })).request({ command: "status" }), "recovered");
    await second.stop();

    await mkdir(sessionDir, { mode: 0o700 });
    await writeFile(join(sessionDir, "claim.json"), JSON.stringify({ ...claim, pid: 2_147_483_647 }), { mode: 0o600 });
    await mkdir(recoveryPath, { mode: 0o700 });
    const old = new Date(Date.now() - 20_000);
    await utimes(recoveryPath, old, old);
    const third = await startSessionSocket({
      checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
      handle: () => null,
    });
    await third.stop();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a live PID blocks only when its recorded process birth still matches", async () => {
  const { scratch, root, runtimeDir } = await fixture();
  const first = await startSessionSocket({
    checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: () => null,
  });
  const sessionDir = dirname(first.descriptorPath);
  const claimPath = join(sessionDir, "claim.json");
  const claim = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
  await first.stop();
  try {
    await mkdir(sessionDir, { mode: 0o700 });
    await writeFile(claimPath, JSON.stringify(claim), { mode: 0o600 });
    await assert.rejects(startSessionSocket({
      checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
      handle: () => null,
    }), codeIs("OWNER_UNRESPONSIVE"));
    if (typeof claim.processBirth === "string") {
      await writeFile(claimPath, JSON.stringify({ ...claim, processBirth: `${claim.processBirth}-prior` }), { mode: 0o600 });
      const recovered = await startSessionSocket({
        checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
        handle: () => null,
      });
      await recovered.stop();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("transport limits responses and safe errors without exposing handler internals", async () => {
  const { scratch, root, runtimeDir } = await fixture();
  const owner = await startSessionSocket({
    checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    maxResponseBytes: 512,
    handle: command => {
      if (command.command === "large") return "x".repeat(1000);
      throw new Error("private token 123");
    },
  });
  try {
    const client = await discoverSessionSocket({ checkoutRoot: root, runtimeDir });
    await assert.rejects(client.request({ command: "large" }), codeIs("RESPONSE_TOO_LARGE"));
    await assert.rejects(client.request({ command: "fail" }), error =>
      error instanceof SessionSocketError && error.code === "REQUEST_FAILED" && !error.message.includes("private token"));
    await assert.rejects(client.request({ command: "huge", payload: "x".repeat(70_000) }), codeIs("REQUEST_TOO_LARGE"));
  } finally {
    await owner.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});
