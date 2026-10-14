import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sha256HexBytes } from "../generation/records.js";
import { parseSourceWorkflow, sourceWorkflow, type SourceWorkflowArgs, type SourceWorkflowContext } from "./source-workflow.js";

async function fixture(run: (root: string, file: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "can-source-workflow-"));
  const file = join(root, "App.can");
  await writeFile(file, "App Workflow\n");
  try { await run(root, file); } finally { await rm(root, { recursive: true, force: true }); }
}

function args(file: string, command: "generate" | "validate" = "validate"): SourceWorkflowArgs {
  return { command, file, retry: false, dryRun: false, format: "json" };
}

function context(root: string, units: object[] = []): SourceWorkflowContext {
  return {
    workspace: root,
    compiler: async text => {
      const request = JSON.parse(text) as { operation: string };
      return { code: 0, stdout: JSON.stringify({ ok: true, units: request.operation === "status" ? units : undefined }) };
    },
    discover: async (_compiler, project) => ({ root: project, files: [], compilerSources: ["App.can"] }),
    appAcceptance: async () => {},
  };
}

test("source argument parsing rejects repeated/unknown flags and resolves file paths", () => {
  const parsed = parseSourceWorkflow("generate", ["App.can", "--retry", "--dry-run", "--format=json"]);
  assert.equal(parsed.file, join(process.cwd(), "App.can"));
  assert.equal(parsed.retry, true); assert.equal(parsed.dryRun, true);
  assert.throws(() => parseSourceWorkflow("validate", ["App.can", "--retry"]), /unexpected argument/);
  assert.throws(() => parseSourceWorkflow("generate", ["App.can", "--retry", "--retry"]), /unexpected argument/);
  assert.throws(() => parseSourceWorkflow("validate", ["App.can", "--format=xml"]), /unexpected argument/);
  for (const options of [["--settings=shared/can.gen.toml"], ["--settings", "shared/can.gen.toml"]]) {
    assert.equal(parseSourceWorkflow("generate", ["App.can", ...options]).settings, resolve("shared/can.gen.toml"));
  }
  for (const options of [["--settings"], ["--settings="], ["--settings", "--dry-run"],
    ["--settings=one.toml", "--settings=two.toml"]]) {
    assert.throws(() => parseSourceWorkflow("generate", ["App.can", ...options]));
  }
  assert.throws(() => parseSourceWorkflow("validate", ["App.can", "--settings=shared.toml"]), /unexpected argument/);
});

test("dry run resolves app-parent settings and exact requested recipes without writing or launching", async () => {
  await fixture(async (root, file) => {
    await writeFile(join(root, "can.gen.toml"), 'version = 1\n[generation]\nrunner = "codex"\nmodel = "gpt-6.1-sol"\n[generation.native]\nmodel_reasoning_effort = "medium"\n[generation.profiles.frontend]\nrunner = "codex"\nmodel = "frontend-model"\n');
    const ctx = context(root, [{ association: "new", kind: "view", owner: "Workflow", contract: { profile: null } },
      { association: "new", kind: "keyword", owner: "Workflow", contract: { profile: null } }]);
    ctx.control = async () => { throw new Error("dry-run must not dispatch generation"); };
    ctx.appAcceptance = async () => { throw new Error("dry-run must not run acceptance"); };
    const before = await readdir(root);
    const result = await sourceWorkflow({ ...args(file, "generate"), dryRun: true }, ctx);
    assert.equal(result.code, 0, result.envelope);
    const body = JSON.parse(result.envelope);
    assert.equal(body.root, root); assert.equal(body.jobs_started, 0);
    assert.equal(body.selection[0].recipe.model, "frontend-model");
    assert.equal(body.selection[1].recipe.model, "gpt-6.1-sol");
    assert.equal(body.selection[1].recipe.native.model_reasoning_effort, "medium");
    assert.deepEqual(await readdir(root), before);
  });
});

test("explicit shared settings replace local settings and reach prepare/retry unchanged", async () => {
  await fixture(async (root) => {
    const appRoot = join(root, "apps", "Nested");
    await mkdir(appRoot, { recursive: true });
    const file = join(appRoot, "Nested.can"), settings = join(root, "shared settings.toml");
    await writeFile(file, "app Nested\n");
    await writeFile(settings, 'version = 1\n[generation]\nrunner = "codex"\nmodel = "gpt-6.1-sol"\n[generation.native]\nmodel_reasoning_effort = "medium"\n');
    await writeFile(join(appRoot, "can.gen.toml"), 'not valid settings');
    const ctx = context(root, [{ association: "new", kind: "view", owner: "Nested", contract: { profile: null } }]);
    const parsed = parseSourceWorkflow("generate", [file, "--settings", relative(process.cwd(), settings), "--dry-run", "--format=json"]);
    const result = await sourceWorkflow(parsed, ctx);
    assert.equal(result.code, 0, result.envelope);
    const body = JSON.parse(result.envelope);
    assert.deepEqual(body.settings, { kind: "explicit", path: settings });
    assert.equal(body.selection[0].recipe.model, "gpt-6.1-sol");
    assert.equal(body.selection[0].recipe.native.model_reasoning_effort, "medium");
    for (const retry of [false, true]) {
      let dispatched = false;
      ctx.control = async text => {
        const request = JSON.parse(text);
        dispatched = true;
        assert.equal(request.settings, settings);
        assert.equal(request.root, appRoot);
        assert.equal(request.operation, retry ? "retry" : "generate");
        assert.equal(request.mode, retry ? undefined : "prepare");
        return { code: 0, envelope: JSON.stringify({ ok: true, state: "accepted" }) };
      };
      const generated = await sourceWorkflow({ ...parsed, dryRun: false, retry }, ctx);
      assert.equal(generated.code, 0, generated.envelope);
      assert.equal(dispatched, true);
    }
  });
});

test("dry run never discovers ancestor settings and refuses a missing explicit file", async () => {
  await fixture(async (root) => {
    const appRoot = join(root, "nested");
    await mkdir(appRoot);
    const file = join(appRoot, "Nested.can");
    await writeFile(file, "app Nested\n");
    await writeFile(join(root, "can.gen.toml"), 'version = 1\n[generation]\nrunner = "codex"\nmodel = "ancestor-model"\n');
    const ctx = context(root, [{ association: "new", kind: "view", owner: "Nested" }]);
    const result = await sourceWorkflow({ ...args(file, "generate"), dryRun: true }, ctx);
    assert.notEqual(result.code, 0);
    const missing = await sourceWorkflow({ ...args(file, "generate"), dryRun: true, settings: join(root, "missing.toml") }, ctx);
    assert.notEqual(missing.code, 0);
    assert.match(missing.envelope, /cannot read settings/);
  });
});

test("validation of a zero-generation app still checks a frozen full app without invoking AI", async () => {
  await fixture(async (root, file) => {
    const ctx = context(root);
    let checked = false;
    ctx.control = async () => { throw new Error("validation cannot launch controls"); };
    ctx.appAcceptance = async input => {
      checked = true;
      assert.notEqual(input.candidateRoot, root);
      assert.equal(input.workspace, root);
      assert.deepEqual(input.files, [basename(file)]);
      assert.equal(await readFile(join(input.candidateRoot, basename(file)), "utf8"), await readFile(file, "utf8"));
    };
    const result = await sourceWorkflow(args(file), ctx);
    assert.equal(result.code, 0, result.envelope); assert.equal(checked, true);
    assert.equal(JSON.parse(result.envelope).validated, true);
    assert.deepEqual(await readdir(join(root, ".can/gen/validate")), []);
  });
});

test("validation rejects missing or ambiguous saved bindings before running the gate", async () => {
  for (const association of ["new", "ambiguous"]) await fixture(async (root, file) => {
    const ctx = context(root, [{ id: null, association, owner: "Workflow", kind: "view" }]);
    ctx.appAcceptance = async () => { throw new Error("invalid saved app must not run gate"); };
    const result = await sourceWorkflow(args(file), ctx);
    assert.notEqual(result.code, 0); assert.match(result.envelope, new RegExp(association));
  });
});

test("saved validation copies exact compiler inputs, rewrites owner paths, and statically validates before acceptance", async () => {
  await fixture(async (root, file) => {
    const unitBytes = await readFile(fileURLToPath(new URL("../../../../tests/fixtures/prompt-pipeline/can.generated/u8/unit.json", import.meta.url)), "utf8");
    const unit = JSON.parse(unitBytes); unit.id = "u8"; unit.source.path = file;
    const group = join(root, "can.generated/u8"); await mkdir(group, { recursive: true });
    await writeFile(join(group, "unit.json"), JSON.stringify(unit));
    await writeFile(join(group, "style.css"), "body { color: blue; }");
    const ctx = context(root, [{ id: "u8", association: "retained", kind: "style", prompt_changed: false }]);
    ctx.discover = async (_compiler, project) => ({ root: project,
      files: await Promise.all(["can.generated/u8/unit.json", "can.generated/u8/style.css"].map(async path => ({ path, sha256: sha256HexBytes(await readFile(join(root, path))) }))), compilerSources: ["App.can"] });
    const operations: string[] = [];
    ctx.compiler = async text => {
      const request = JSON.parse(text); operations.push(request.operation);
      if (request.operation === "validate") {
        assert.equal(request.unit_id, "u8");
        assert.notEqual(request.root, root);
        assert.equal(JSON.parse(await readFile(join(request.root, "can.generated/u8/unit.json"), "utf8")).source.path, "App.can");
      }
      return { code: 0, stdout: JSON.stringify({ ok: true, units: [{ id: "u8", association: "retained", prompt_changed: false }] }) };
    };
    ctx.appAcceptance = async () => { assert.deepEqual(operations, ["status", "validate"]); operations.push("gate"); };
    const savedBefore = await readFile(join(group, "unit.json"));
    const result = await sourceWorkflow(args(file), ctx);
    assert.equal(result.code, 0, result.envelope);
    assert.deepEqual(await readFile(join(group, "unit.json")), savedBefore);
  });
});

test("acceptance failure or mutation of frozen/live inputs refuses success and releases scratch", async () => {
  for (const change of ["failure", "frozen", "live"]) await fixture(async (root, file) => {
    const ctx = context(root);
    ctx.appAcceptance = async input => {
      if (change === "failure") throw new Error("browser failed; see acceptance report");
      await writeFile(change === "frozen" ? join(input.candidateRoot, basename(file)) : file, "changed");
    };
    const result = await sourceWorkflow(args(file), ctx);
    assert.notEqual(result.code, 0);
    assert.match(result.envelope, change === "failure" ? /browser failed/ : /changed during checks/);
    assert.deepEqual(await readdir(join(root, ".can/gen/validate")), []);
  });
});

test("generation defaults to accepted prepare, retry composes accepted retry, and incomplete candidates fail", async () => {
  await fixture(async (root, file) => {
    for (const retry of [false, true]) {
      const ctx = context(root);
      ctx.control = async (text, controlContext) => {
        const request = JSON.parse(text);
        assert.equal(request.operation, retry ? "retry" : "generate");
        assert.equal(request.mode, retry ? undefined : "prepare");
        assert.equal(request.accept, true); assert.equal(request.root, root); assert.deepEqual(request.files, [file]);
        assert.equal(controlContext?.workspace, root);
        return { code: 0, envelope: JSON.stringify({ ok: true, state: "accepted", accepted: { run: "run" } }) };
      };
      ctx.appAcceptance = async () => { throw new Error("accepted output must not be checked twice"); };
      assert.equal((await sourceWorkflow({ ...args(file, "generate"), retry }, ctx)).code, 0);
    }
    const incomplete = context(root);
    incomplete.control = async () => ({ code: 0, envelope: JSON.stringify({ ok: true, state: "candidate", attempts: [{}], accepted: false }) });
    assert.equal((await sourceWorkflow(args(file, "generate"), incomplete)).code, 4);
    const failed = context(root);
    const error = { code: "validation-failure", message: "compiler inputs changed; current files preserved" };
    failed.control = async () => ({ code: 4, envelope: JSON.stringify({ ok: false, state: "failed", error, next: ["send accept with a new request id"] }) });
    const refusal = await sourceWorkflow({ ...args(file, "generate"), retry: true }, failed);
    assert.equal(refusal.code, 4);
    const body = JSON.parse(refusal.envelope);
    assert.deepEqual(body.error, error); assert.equal(body.state, "failed");
    assert.equal(body.command, "generate"); assert.equal(body.file, file);
    assert.deepEqual(body.next, [`repair the reported issue, then rerun can gen ${JSON.stringify(file)} --retry`]);
    assert.doesNotMatch(JSON.stringify(body.next), /request id|send accept/);
  });
});

test("prepare reuse passes saved app acceptance and retains honest nonpromotion state", async () => {
  await fixture(async (root, file) => {
    const ctx = context(root); let gates = 0;
    ctx.control = async () => ({ code: 0, envelope: JSON.stringify({ ok: true, state: "candidate", attempts: [], accepted: false }) });
    ctx.appAcceptance = async () => { gates += 1; };
    const result = await sourceWorkflow(args(file, "generate"), ctx);
    assert.equal(result.code, 0, result.envelope); assert.equal(gates, 1);
    const body = JSON.parse(result.envelope);
    assert.equal(body.accepted, false); assert.equal(body.saved_validation.validated, true);
  });
});
