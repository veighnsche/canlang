import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { attachDevSessionService, startDevSessionService } from "./session-service.js";
import { SessionSocketError } from "./session-socket.js";

const project = fileURLToPath(new URL("../../../../", import.meta.url));

test("the frozen Office Supplies source gets revision-bound diagnostics and no invented preview", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cv-"));
  const root = join(scratch, "c");
  const runtimeDir = join(scratch, "r");
  await mkdir(root, { mode: 0o700 });
  await mkdir(runtimeDir, { mode: 0o700 });
  const sourcePath = join(root, "OfficeSupplies.can");
  const frozenSource = await readFile(join(project, "tests/integration/can-dev-server/OfficeSupplies.can"), "utf8");
  await writeFile(sourcePath, frozenSource);
  const owner = await startDevSessionService({
    selectedApp: "OfficeSupplies",
    runtimeDir,
    capture: {
      checkoutRoot: root,
      appPath: "OfficeSupplies.can",
      profile: "local-d1-identity",
      compilerPath: join(project, "compiler/target/debug/can"),
      catalogPath: join(project, "packages/values/dist/catalog.json"),
      helpIndexPath: join(project, "docs/specification/CONSTRUCT-HELP.md"),
      packageInputPaths: [
        { name: "cloudflare-worker", path: join(project, "packages/cloudflare/dist/worker/assembly.js") },
      ],
    },
  });
  try {
    const client = await attachDevSessionService({ checkoutRoot: root, app: "OfficeSupplies", profile: "local-d1-identity", runtimeDir });
    const initial = await client.request({ command: "status" }) as { session: string; preview: string };
    assert.equal(initial.session, owner.identity.sessionId);
    assert.equal(initial.preview, "unavailable");
    const help = await client.request({ command: "help" }) as {
      schema: string; commands: { name: string; output: string }[];
      unavailable: { name: string; code: string }[];
    };
    assert.equal(help.schema, "can.dev.help.v1");
    assert.ok(help.commands.some(command => command.name === "check" && command.output === "can.dev.check.v1"));
    assert.ok(!help.commands.some(command => command.name === "example.run"));
    assert.ok(help.unavailable.some(command => command.name === "example.run" && command.code === "FEATURE_UNAVAILABLE"));
    await assert.rejects(client.request({ command: "example.run" }), error =>
      error instanceof SessionSocketError && error.code === "FEATURE_UNAVAILABLE");
    const first = await client.request({ command: "check" }) as {
      revision: string; source_revision: string; state: string; preview: string;
      evidence: { diagnostics_reported: number }; focus: { ref: string } | null;
    };
    assert.match(first.revision, /^r[1-9]/);
    assert.match(first.source_revision, /^sha256:[a-f0-9]{64}$/);
    assert.ok(first.state === "errors" || first.state === "valid" || first.state === "limited", first.state);
    assert.equal(first.preview, "unavailable");
    await assert.rejects(client.request({ command: "preview.open" }), error =>
      error instanceof SessionSocketError && error.code === "PREVIEW_UNAVAILABLE");
    if (first.evidence.diagnostics_reported > 0) {
      const original = await client.request({ command: "diagnostic.detail", payload: { revision: first.revision, index: 0 } }) as {
        ref: string; source_revision: string; source: { sha256: string };
        diagnostic: { code: string; message: string; primary: { file: number; start: number; end: number } };
      };
      assert.equal(original.ref, first.focus?.ref);
      assert.equal(original.source_revision, first.source_revision);
      assert.ok(original.diagnostic.primary.end >= original.diagnostic.primary.start);
      const failure = await client.request({ command: "failure.lookup", payload: { ref: original.ref } }) as {
        ref: string; revision: string; source_revision: string;
        at: { kind: string; sha256: string; start: number; end: number };
        evidence: { missing: string[] };
      };
      assert.equal(failure.ref, original.ref);
      assert.equal(failure.revision, first.revision);
      assert.equal(failure.source_revision, first.source_revision);
      assert.equal(failure.at.kind, "exact_span");
      assert.equal(failure.at.sha256, original.source.sha256);
      assert.ok(failure.evidence.missing.includes("causal_trace_unavailable"));
      const safe = await client.request({ command: "failure.detail", payload: { ref: original.ref } }) as {
        revision: string; detail: { message: string };
      };
      assert.equal(safe.revision, first.revision);
      assert.equal(safe.detail.message, original.diagnostic.message);
      await assert.rejects(client.request({ command: "failure.lookup", payload: { ref: `foreign/${first.revision}/d0` } }),
        error => error instanceof SessionSocketError && error.code === "INVALID_FAILURE_REF");
    }
    await writeFile(sourcePath, `${frozenSource}\n## New local revision.\n`);
    const second = await client.request({ command: "check" }) as { revision: string; source_revision: string };
    assert.notEqual(second.revision, first.revision);
    assert.notEqual(second.source_revision, first.source_revision);
    const old = await client.request({ command: "diagnostics", payload: { revision: first.revision, limit: 2 } }) as {
      current: boolean; source_revision: string; reported: number;
    };
    assert.equal(old.current, false);
    assert.equal(old.source_revision, first.source_revision);
    assert.equal(old.reported, first.evidence.diagnostics_reported);
    if (first.focus !== null) {
      const historical = await client.request({ command: "failure.lookup", payload: { ref: first.focus.ref } }) as {
        revision: string; source_revision: string;
      };
      assert.equal(historical.revision, first.revision);
      assert.equal(historical.source_revision, first.source_revision);
    }
    await writeFile(sourcePath, [
      "# Track office supplies.",
      "app OfficeSupplies",
      "Given",
      " Supply { name:text }",
      " policy Supply read=members",
      "When",
      " crud Supply by=members fields=name",
      "Then",
      " page / title=\"Office supplies\"",
      "  list Supply",
      "",
    ].join("\n"));
    const valid = await client.request({ command: "check" }) as { state: string; preview: string };
    assert.equal(valid.state, "valid");
    assert.equal(valid.preview, "unavailable");
    const status = await client.request({ command: "status" }) as { serving_build: string | null };
    assert.equal(status.serving_build, null);
    const stopped = await client.request({ command: "stop" }) as { stopping: boolean };
    assert.equal(stopped.stopping, true);
    await owner.stop();
    await assert.rejects(attachDevSessionService({ checkoutRoot: root, runtimeDir }));
  } finally {
    await owner.stop();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("stop releases the owned socket even when preview disposal fails", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cv-"));
  const root = join(scratch, "c");
  const runtimeDir = join(scratch, "r");
  await mkdir(root, { mode: 0o700 });
  await mkdir(runtimeDir, { mode: 0o700 });
  await writeFile(join(root, "OfficeSupplies.can"), [
    "# Track office supplies.",
    "app OfficeSupplies",
    "Given",
    " Supply { name:text }",
    " policy Supply read=members",
    "When",
    " crud Supply by=members fields=name",
    "Then",
    " page / title=\"Office supplies\"",
    "  list Supply",
    "",
  ].join("\n"));
  const owner = await startDevSessionService({
    selectedApp: "OfficeSupplies", runtimeDir,
    capture: {
      checkoutRoot: root, appPath: "OfficeSupplies.can", profile: "local-d1-identity",
      compilerPath: join(project, "compiler/target/debug/can"),
      catalogPath: join(project, "packages/values/dist/catalog.json"),
      helpIndexPath: join(project, "docs/specification/CONSTRUCT-HELP.md"),
      packageInputPaths: [{ name: "cloudflare-worker", path: join(project, "packages/cloudflare/dist/worker/assembly.js") }],
    },
    previewBuilder: async () => ({ id: "faulty-preview", dispose: async () => { throw new Error("dispose failed"); } }),
  });
  try {
    const client = await attachDevSessionService({ checkoutRoot: root, runtimeDir });
    const checked = await client.request({ command: "check" }) as { state: string; preview: string };
    assert.equal(checked.state, "valid");
    assert.equal(checked.preview, "ready");
    await client.request({ command: "stop" });
    await assert.rejects(owner.stop(), /dispose failed/);
    await assert.rejects(attachDevSessionService({ checkoutRoot: root, runtimeDir }));
  } finally {
    await owner.stop().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
});
