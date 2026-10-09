import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

    await assert.rejects(startDevDaemon({ selectedApp: "OfficeSupplies", capture, runtimeDir }),
      error => error instanceof SessionSocketError && error.code === "SESSION_EXISTS");

    const stopped = await stopDevDaemon({ checkoutRoot: root, sessionId: started.identity.sessionId, runtimeDir });
    assert.deepEqual(stopped, { session: started.identity.sessionId, stopped: true });
    await assert.rejects(discoverDevDaemon({ checkoutRoot: root, runtimeDir }));
  } finally {
    try { await stopDevDaemon({ checkoutRoot: root, runtimeDir }, 500); } catch { /* no live owner */ }
    await rm(scratch, { recursive: true, force: true });
  }
});
