import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
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

test("concurrent starts claim exactly one usable owner for the same root", async () => {
  const { scratch, root, runtimeDir } = await fixture();
  const options = { checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: () => "winner" };
  const results = await Promise.allSettled([startSessionSocket(options), startSessionSocket(options)]);
  const owners = results.filter(result => result.status === "fulfilled").map(result => result.value);
  try {
    assert.equal(owners.length, 1);
    const losers = results.filter(result => result.status === "rejected");
    assert.equal(losers.length, 1);
    assert.ok(losers[0]!.reason instanceof SessionSocketError);
    assert.ok(["SESSION_EXISTS", "CLAIM_IN_PROGRESS", "OWNER_UNRESPONSIVE", "RECOVERY_IN_PROGRESS"]
      .includes(losers[0]!.reason.code));
    const client = await discoverSessionSocket({ checkoutRoot: root, runtimeDir });
    assert.equal(client.identity.sessionId, owners[0]!.identity.sessionId);
    assert.equal(await client.request({ command: "status" }), "winner");
  } finally {
    await Promise.all(owners.map(owner => owner.stop()));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a stalled incomplete starter cannot publish into or clean up the takeover winner", { timeout: 10_000 }, async t => {
  const { scratch, root, runtimeDir } = await fixture();
  const sessionDir = join(await realpath(runtimeDir), createHash("sha256").update(await realpath(root)).digest("hex").slice(0, 24));
  const originalLstat = fs.lstat;
  let reached!: () => void;
  const paused = new Promise<void>(resolve => { reached = resolve; });
  let resume!: () => void;
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  let intercepted = false;
  const hook = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const info = await originalLstat(...args);
    if (args[0] === sessionDir && !intercepted) {
      intercepted = true;
      reached();
      await resumed;
    }
    return info;
  });
  syncBuiltinESMExports();
  const options = { checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: () => "winner" };
  const stalled = startSessionSocket(options);
  let winner: Awaited<ReturnType<typeof startSessionSocket>> | undefined;
  try {
    await Promise.race([paused, new Promise<never>((_, reject) => {
      t.signal.addEventListener("abort", () => reject(new Error("starter pause was not reached")), { once: true });
    })]);
    const old = new Date(Date.now() - 20_000);
    await utimes(sessionDir, old, old);
    winner = await startSessionSocket(options);
    const descriptor = await readFile(winner.descriptorPath, "utf8");
    const claim = await readFile(join(sessionDir, "claim.json"), "utf8");
    resume();
    await assert.rejects(stalled, codeIs("CLAIM_LOST"));
    assert.equal(await readFile(winner.descriptorPath, "utf8"), descriptor);
    assert.equal(await readFile(join(sessionDir, "claim.json"), "utf8"), claim);
    const client = await discoverSessionSocket({ checkoutRoot: root, runtimeDir });
    assert.equal(client.identity.sessionId, winner.identity.sessionId);
    assert.equal(await client.request({ command: "status" }), "winner");
  } finally {
    resume();
    await stalled.then(owner => owner.stop(), () => undefined);
    hook.mock.restore();
    syncBuiltinESMExports();
    await winner?.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a claim lost before descriptor publication is refused without deleting its replacement", async t => {
  const { scratch, root, runtimeDir } = await fixture();
  const originalWriteFile = fs.writeFile;
  let replacedClaimPath: string | undefined;
  const hook = t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    await originalWriteFile(...args);
    if (typeof args[0] === "string" && /descriptor-.*\.tmp$/.test(args[0])) {
      replacedClaimPath = join(dirname(args[0]), "claim.json");
      const claim = JSON.parse(await readFile(replacedClaimPath, "utf8"));
      await originalWriteFile(replacedClaimPath, JSON.stringify({ ...claim, sessionId: "replacement" }), { mode: 0o600 });
    }
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(startSessionSocket({ checkoutRoot: root, app: "OfficeSupplies",
      profile: "local-d1-identity", runtimeDir, handle: () => null }), codeIs("CLAIM_LOST"));
    assert.ok(replacedClaimPath);
    assert.equal(JSON.parse(await readFile(replacedClaimPath, "utf8")).sessionId, "replacement");
    await assert.rejects(lstat(join(dirname(replacedClaimPath), "descriptor.json")), { code: "ENOENT" });
  } finally {
    hook.mock.restore();
    syncBuiltinESMExports();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("failed final directory release restores the same verified status and stop retry route", async t => {
  const { scratch, root, runtimeDir } = await fixture();
  let retried!: (value: Promise<void>) => void;
  const retryStarted = new Promise<Promise<void>>(resolve => { retried = resolve; });
  let owner!: Awaited<ReturnType<typeof startSessionSocket>>;
  owner = await startSessionSocket({ checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: command => {
      if (command.command === "stop") {
        setTimeout(() => { retried(owner.stop()); }, 20);
        return "retrying";
      }
      return "shutdown incomplete";
    } });
  const sessionDir = dirname(owner.descriptorPath);
  const originalRmdir = fs.rmdir;
  const failure = Object.assign(new Error("injected final directory release failure"), { code: "EACCES" });
  let failed = false;
  const hook = t.mock.method(fs, "rmdir", async (...args: Parameters<typeof fs.rmdir>) => {
    if (args[0] === sessionDir && !failed) {
      failed = true;
      throw failure;
    }
    return originalRmdir(...args);
  });
  syncBuiltinESMExports();
  try {
    const first = owner.stop();
    assert.equal(owner.stop(), first);
    await assert.rejects(first, error => error === failure);
    const client = await discoverSessionSocket({ checkoutRoot: root, runtimeDir });
    assert.equal(client.identity.sessionId, owner.identity.sessionId);
    assert.equal(await client.request({ command: "status" }), "shutdown incomplete");
    assert.equal(JSON.parse(await readFile(join(sessionDir, "claim.json"), "utf8")).sessionId, owner.identity.sessionId);
    assert.equal(await client.request({ command: "stop" }), "retrying");
    await retryStarted;
    await assert.rejects(lstat(sessionDir), { code: "ENOENT" });
  } finally {
    hook.mock.restore();
    syncBuiltinESMExports();
    await owner.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("cleanup recovery refuses a replacement directory and leaves its verified owner intact", async t => {
  const { scratch, root, runtimeDir } = await fixture();
  const options = { checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: () => "replacement owner" };
  const original = await startSessionSocket(options);
  const sessionDir = dirname(original.descriptorPath);
  const displaced = `${sessionDir}.displaced`;
  const originalRmdir = fs.rmdir;
  let replacement: Awaited<ReturnType<typeof startSessionSocket>> | undefined;
  const failure = Object.assign(new Error("directory replaced during failed cleanup"), { code: "EACCES" });
  const hook = t.mock.method(fs, "rmdir", async (...args: Parameters<typeof fs.rmdir>) => {
    if (args[0] === sessionDir && !replacement) {
      await rename(sessionDir, displaced);
      replacement = await startSessionSocket(options);
      throw failure;
    }
    return originalRmdir(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(original.stop(), error => error === failure);
    assert.ok(replacement);
    const descriptor = await readFile(replacement.descriptorPath, "utf8");
    const claim = await readFile(join(sessionDir, "claim.json"), "utf8");
    await original.stop();
    assert.equal(await readFile(replacement.descriptorPath, "utf8"), descriptor);
    assert.equal(await readFile(join(sessionDir, "claim.json"), "utf8"), claim);
    const client = await discoverSessionSocket({ checkoutRoot: root, runtimeDir });
    assert.equal(client.identity.sessionId, replacement.identity.sessionId);
    assert.equal(await client.request({ command: "status" }), "replacement owner");
  } finally {
    hook.mock.restore();
    syncBuiltinESMExports();
    await original.stop();
    await replacement?.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("socket cleanup failure retains the claim and concurrent callers join a retry", {
  skip: typeof process.getuid !== "function" || process.getuid() === 0,
}, async () => {
  const { scratch, root, runtimeDir } = await fixture();
  const options = { checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: () => null };
  const owner = await startSessionSocket(options);
  const sessionDir = dirname(owner.descriptorPath);
  try {
    await chmod(sessionDir, 0o500);
    const firstStop = owner.stop();
    assert.equal(owner.stop(), firstStop);
    await assert.rejects(firstStop, error => ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""));
    assert.equal(JSON.parse(await readFile(join(sessionDir, "claim.json"), "utf8")).sessionId, owner.identity.sessionId);
    const client = await discoverSessionSocket({ checkoutRoot: root, runtimeDir });
    assert.equal(client.identity.sessionId, owner.identity.sessionId);
    assert.equal(await client.request({ command: "status" }), null);
    await assert.rejects(startSessionSocket(options), codeIs("SESSION_EXISTS"));
    await chmod(sessionDir, 0o700);
    // A recursive removal may remove the claim before failing on a sibling.
    await rm(join(sessionDir, "claim.json"));
    const retry = owner.stop();
    assert.equal(owner.stop(), retry);
    await retry;
    await assert.rejects(lstat(sessionDir), error => (error as NodeJS.ErrnoException).code === "ENOENT");
    const replacement = await startSessionSocket(options);
    await replacement.stop();
  } finally {
    await chmod(sessionDir, 0o700).catch(() => undefined);
    await owner.stop();
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

test("a crashed Linux owner left as a zombie does not block exclusive recovery", { skip: process.platform !== "linux" }, async () => {
  const { scratch, root, runtimeDir } = await fixture();
  const first = await startSessionSocket({
    checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: () => null,
  });
  const sessionDir = dirname(first.descriptorPath);
  const claim = JSON.parse(await readFile(join(sessionDir, "claim.json"), "utf8")) as Record<string, unknown>;
  const descriptor = await readFile(first.descriptorPath, "utf8");
  await first.stop();
  const releasePath = join(scratch, "release-zombie-parent");
  const childCode = `const {spawn}=require("node:child_process"); const {existsSync}=require("node:fs");
    const child=spawn(process.execPath,["-e","process.exit(0)"],{stdio:"ignore"});
    child.once("exit",()=>process.exit(0)); process.stdout.write(String(child.pid)+"\\n");
    const wait=new Int32Array(new SharedArrayBuffer(4)); const end=Date.now()+10000;
    while(!existsSync(process.argv[1]) && Date.now()<end) Atomics.wait(wait,0,0,20);`;
  const parent = spawn(process.execPath, ["-e", childCode, releasePath], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const [chunk] = await once(parent.stdout!, "data");
    const zombiePid = Number(String(chunk).trim());
    assert.ok(Number.isSafeInteger(zombiePid) && zombiePid > 0);
    let entry = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      entry = await readFile(`/proc/${zombiePid}/stat`, "utf8");
      if (entry.slice(entry.lastIndexOf(")") + 1).trimStart().startsWith("Z ")) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const fields = entry.slice(entry.lastIndexOf(")") + 1).trim().split(/\s+/);
    assert.equal(fields[0], "Z");
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    await mkdir(sessionDir, { mode: 0o700 });
    await writeFile(join(sessionDir, "claim.json"), JSON.stringify({ ...claim, pid: zombiePid,
      processBirth: `proc:${bootId}:${fields[19]}` }), { mode: 0o600 });
    await writeFile(first.descriptorPath, descriptor, { mode: 0o600 });
    const recovered = await startSessionSocket({
      checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
      handle: () => "recovered",
    });
    try {
      assert.notEqual(recovered.identity.sessionId, first.identity.sessionId);
      assert.equal(await (await discoverSessionSocket({ checkoutRoot: root, runtimeDir }))
        .request({ command: "status" }), "recovered");
    } finally {
      await recovered.stop();
    }
  } finally {
    await writeFile(releasePath, "done");
    if (parent.exitCode === null) await once(parent, "exit").catch(() => undefined);
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

test("disconnecting an authenticated pending peer aborts only its request and preserves owned cleanup", { timeout: 10_000 }, async () => {
  const { scratch, root, runtimeDir } = await fixture();
  let entered!: () => void;
  const pendingEntered = new Promise<void>(resolve => { entered = resolve; });
  let requestSignal: AbortSignal | undefined;
  const owner = await startSessionSocket({
    checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    requestTimeoutMs: 10_000,
    handle: async (command, signal) => {
      if (command.command !== "pending") return "still serving";
      requestSignal = signal;
      entered();
      await once(signal, "abort");
      return "disconnected response";
    },
  });
  const peer = createConnection(owner.identity.socketPath);
  try {
    await once(peer, "connect");
    const hello = once(peer, "data");
    peer.write(`${JSON.stringify({ type: "hello", ...owner.identity, nonce: "a".repeat(32) })}\n`);
    const [reply] = await hello;
    assert.equal(JSON.parse(String(reply)).type, "hello");
    peer.write(`${JSON.stringify({ type: "request", id: "disconnected", command: "pending" })}\n`);
    await pendingEntered;
    assert.ok(requestSignal);
    const aborted = once(requestSignal, "abort", { signal: AbortSignal.timeout(1_500) });
    peer.destroy();
    await aborted;
    assert.equal(requestSignal.aborted, true);
    const client = await discoverSessionSocket({ checkoutRoot: root, runtimeDir });
    assert.equal(client.identity.sessionId, owner.identity.sessionId);
    assert.equal(await client.request({ command: "status" }), "still serving");
    await owner.stop();
    await assert.rejects(lstat(owner.descriptorPath), { code: "ENOENT" });
    await assert.rejects(lstat(owner.identity.socketPath), { code: "ENOENT" });
  } finally {
    peer.destroy();
    await owner.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("an attached request signal detaches its socket without stopping the owner", { timeout: 10_000 }, async () => {
  const { scratch, root, runtimeDir } = await fixture();
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  let aborted!: () => void;
  const peerAborted = new Promise<void>(resolve => { aborted = resolve; });
  const owner = await startSessionSocket({ checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir,
    handle: async (command, signal) => {
      if (command.command !== "pending") return "owner remains";
      entered();
      await once(signal, "abort");
      aborted();
      return null;
    } });
  try {
    const client = await discoverSessionSocket({ checkoutRoot: root, runtimeDir });
    const detach = new AbortController();
    const request = client.request({ command: "pending" }, detach.signal);
    await pending;
    detach.abort();
    await assert.rejects(request, codeIs("REQUEST_ABORTED"));
    await peerAborted;
    assert.equal(await client.request({ command: "status" }), "owner remains");
    await assert.rejects(client.request({ command: "status" }, detach.signal), codeIs("REQUEST_ABORTED"));
  } finally {
    await owner.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("disconnected real handshake and response peers cannot crash a separate owner process", { timeout: 20_000 }, async () => {
  const { scratch, root, runtimeDir } = await fixture();
  const moduleUrl = new URL("./session-socket.js", import.meta.url).href;
  // The child has ordinary Node fatal-error behavior. Only client-side peers
  // handle their own connection errors; no owner/global error handler exists.
  const childCode = `
    import assert from 'node:assert/strict';
    import {createConnection} from 'node:net';
    import {once} from 'node:events';
    import {lstat} from 'node:fs/promises';
    import {startSessionSocket,discoverSessionSocket} from ${JSON.stringify(moduleUrl)};
    const owner=await startSessionSocket({checkoutRoot:process.argv[1],app:'OfficeSupplies',
      profile:'local-d1-identity',runtimeDir:process.argv[2],handle:()=> 'alive'});
    const hello=JSON.stringify({type:'hello',...owner.identity,nonce:'b'.repeat(32)})+'\\n';
    try {
      for(let index=0;index<48;index++) {
        const peer=createConnection(owner.identity.socketPath);
        peer.on('error',error=>assert.ok(['EPIPE','ECONNRESET'].includes(error.code)));
        await once(peer,'connect');
        const closed=new Promise(resolve=>peer.once('close',resolve));
        if(index<32) {
          peer.end(hello,()=>peer.destroy());
        } else {
          const reply=once(peer,'data'); peer.write(hello); await reply;
          peer.end(JSON.stringify({type:'request',id:'gone-'+index,command:'status'})+'\\n',()=>peer.destroy());
        }
        await closed;
        const client=await discoverSessionSocket({checkoutRoot:process.argv[1],runtimeDir:process.argv[2]});
        assert.equal(client.identity.sessionId,owner.identity.sessionId);
        assert.equal(await client.request({command:'status'}),'alive');
      }
      await owner.stop();
      await assert.rejects(lstat(owner.descriptorPath),{code:'ENOENT'});
      await assert.rejects(lstat(owner.identity.socketPath),{code:'ENOENT'});
      process.stdout.write('peers=48 owner=alive cleanup=complete\\n');
    } finally { await owner.stop(); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode, root, runtimeDir],
    { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { errors += chunk; });
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const deadline = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
  try {
    const exit = await completed;
    assert.equal(exit.signal, null, "separate socket owner must complete without forced termination");
    assert.equal(exit.code, 0, errors);
    assert.equal(errors, "");
    assert.equal(output, "peers=48 owner=alive cleanup=complete\n");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await completed;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
