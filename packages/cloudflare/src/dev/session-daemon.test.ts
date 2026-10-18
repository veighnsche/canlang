import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { discoverDevDaemon, startDevDaemon, stopDevDaemon } from "./session-daemon.js";
import { SessionSocketError } from "./session-socket.js";

test("daemon handshake admits exact current inputs, attaches, and releases its owner", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cv-"));
  const root = join(scratch, "c");
  const runtimeDir = join(scratch, "r");
  await mkdir(root, { mode: 0o700 });
  await mkdir(runtimeDir, { mode: 0o700 });
  await writeFile(join(root, "OfficeSupplies.can"), "app OfficeSupplies\nGiven\n Supply { name:text }\nWhen\nThen\n");
  await writeFile(join(root, "catalog.json"), "{}\n");
  await writeFile(join(root, "help.md"), "# Help\n");
  await writeFile(join(root, "installed.js"), "export const installed = true;\n");
  const capture = {
    checkoutRoot: root,
    appPath: "OfficeSupplies.can",
    profile: "local-d1-identity",
    compilerPath: process.execPath,
    catalogPath: "catalog.json",
    helpIndexPath: "help.md",
    packageInputPaths: [{ name: "installed-runtime", path: "installed.js" }],
  };
  try {
    await assert.rejects(startDevDaemon({
      selectedApp: "OfficeSupplies", runtimeDir,
      capture: { ...capture, catalogPath: null },
    }), error => error instanceof SessionSocketError && error.code === "CAPTURE_INCOMPLETE");

    const started = await startDevDaemon({ selectedApp: "OfficeSupplies", capture, runtimeDir });
    assert.equal(started.attached, false);
    assert.equal(started.status.session, started.identity.sessionId);
    assert.equal(started.status.preview, "unavailable");
    assert.equal(started.status.serving_build, null);
    assert.match(started.status.source_revision ?? "", /^sha256:[a-f0-9]{64}$/);

    const discovered = await discoverDevDaemon({ checkoutRoot: root, app: "OfficeSupplies", runtimeDir });
    assert.equal(discovered.attached, true);
    assert.equal(discovered.identity.sessionId, started.identity.sessionId);
    await assert.rejects(discoverDevDaemon({ checkoutRoot: root, app: "Other", runtimeDir }),
      error => error instanceof SessionSocketError && error.code === "SESSION_MISMATCH");

    // An explicit seed configuration cannot attach to a differently seeded
    // owner; starts always preserve the existing exclusive session.
    await assert.rejects(startDevDaemon({ selectedApp: "OfficeSupplies", capture, runtimeDir,
      previewRoles: { Ava: ["curator"] } }),
      error => error instanceof SessionSocketError && error.code === "SESSION_EXISTS");

    const stopped = await stopDevDaemon({ checkoutRoot: root, sessionId: started.identity.sessionId, runtimeDir });
    assert.deepEqual(stopped, { session: started.identity.sessionId, stopped: true });
    await assert.rejects(discoverDevDaemon({ checkoutRoot: root, runtimeDir }));
  } finally {
    try { await stopDevDaemon({ checkoutRoot: root, runtimeDir }, 500); } catch { /* no live owner */ }
    await rm(scratch, { recursive: true, force: true });
  }
});

test("oversized startup setup is refused before spawning a detached owner or reply timer", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cv-start-size-"));
  const root = join(scratch, "c");
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, "App.can"), "app App\nGiven\nWhen\nThen\n");
  await writeFile(join(root, "catalog.json"), "{}\n");
  await writeFile(join(root, "help.md"), "# Help\n");
  await writeFile(join(root, "installed.js"), "export const installed = true;\n");
  const entryPath = join(scratch, "owner.mjs");
  await writeFile(entryPath, "throw new Error('oversized setup must not launch');\n");
  try {
    const capture = {
      checkoutRoot: root, appPath: "App.can", profile: "local-d1-identity",
      compilerPath: process.execPath, catalogPath: "catalog.json", helpIndexPath: "help.md",
      packageInputPaths: [{ name: "installed", path: "installed.js" }],
      // Unknown host data must still obey the encoded private IPC byte cap.
      extraHostData: "x".repeat(1024 * 1024),
    };
    await assert.rejects(startDevDaemon({ selectedApp: "App", capture }, {
      entryPath, execPath: join(scratch, "must-not-spawn"),
    }), error => error instanceof SessionSocketError && error.code === "INVALID_START");
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

for (const changedInput of ["source", "producer"] as const) {
  test(`daemon refuses a same-size ${changedInput} change at final handoff and releases its child`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), "cv-"));
    const root = join(scratch, "c");
    const runtimeDir = join(scratch, "r");
    const pidPath = join(scratch, "pid");
    const releasedPath = join(scratch, "released");
    await mkdir(root, { mode: 0o700 });
    await mkdir(runtimeDir, { mode: 0o700 });
    const source = "app App\nGiven\nWhen\nThen\n## A\n";
    const producer = "export const installed = 'A';\n";
    await writeFile(join(root, "App.can"), source);
    await writeFile(join(root, "installed.js"), producer);
    await writeFile(join(root, "catalog.json"), "{}\n");
    await writeFile(join(root, "help.md"), "# Help\n");
    const changedPath = join(root, changedInput === "source" ? "App.can" : "installed.js");
    const before = changedInput === "source" ? source : producer;
    const after = changedInput === "source" ? before.replace("## A", "## B") : before.replace("'A'", "'B'");
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
    const entryPath = join(scratch, "owner.mjs");
    // A real private socket supplies the expected revision, then changes disk
    // while answering status. This deterministically reaches the launcher's
    // final currency check after admission and verified owner discovery.
    await writeFile(entryPath, `
import { writeFile } from 'node:fs/promises';
import { startSessionSocket } from ${JSON.stringify(new URL("./session-socket.js", import.meta.url).href)};
process.once('message', async request => {
  const owner = await startSessionSocket({
    checkoutRoot: request.capture.checkoutRoot, app: request.selectedApp,
    profile: request.capture.profile, runtimeDir: request.runtimeDir,
    async handle({ command }) {
      if (command !== 'status') throw new Error('unexpected command');
      await writeFile(${JSON.stringify(changedPath)}, ${JSON.stringify(after)});
      return { schema: 'can.dev.status.v1', session: owner.identity.sessionId,
        app: owner.identity.app, profile: owner.identity.profile,
        source_revision: request.expectedSourceRevision };
    },
  });
  process.once('SIGTERM', async () => {
    await owner.stop();
    await writeFile(${JSON.stringify(releasedPath)}, 'released');
    process.exit(0);
  });
  await writeFile(${JSON.stringify(pidPath)}, String(process.pid));
  process.send({ type: 'ready', identity: owner.identity });
});
`);
    let childPid: number | undefined;
    try {
      await assert.rejects(startDevDaemon({ selectedApp: "App", runtimeDir, capture: {
        checkoutRoot: root, appPath: "App.can", profile: "local-d1-identity",
        compilerPath: process.execPath, catalogPath: "catalog.json", helpIndexPath: "help.md",
        packageInputPaths: [{ name: "installed", path: "installed.js" }],
      } }, { entryPath }), error => error instanceof SessionSocketError && error.code === "CAPTURE_CHANGED");
      childPid = Number(await readFile(pidPath, "utf8"));
      assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
      const deadline = Date.now() + 5_000;
      while (true) {
        try { process.kill(childPid, 0); }
        catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
          break;
        }
        assert.ok(Date.now() < deadline, "rejected startup child must exit");
        await setTimeout(10);
      }
      assert.equal(await readFile(releasedPath, "utf8"), "released");
      await assert.rejects(discoverDevDaemon({ checkoutRoot: root, runtimeDir }));
    } finally {
      if (childPid !== undefined) {
        try { process.kill(childPid, "SIGTERM"); } catch { /* already released */ }
      }
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
