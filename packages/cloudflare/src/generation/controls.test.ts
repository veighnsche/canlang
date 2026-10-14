/**
 * BGI-12 control layer tests: capture, composed execution,
 * validation-to-promotion joins, adoption, rollback, leases,
 * recovery, diff/preview, and the status produced-work overlay.
 *
 * A disk-backed fake compiler implements status/bind/validate over
 * canned descriptors (association reads real unit.json records, so
 * capture/bind/accept flows run end to end); fake runner scripts
 * exit 0 after the test's MCP submissions land. Journals, leases,
 * fences, and the request ledgers are the real mechanisms. One
 * real-compiler test runs when the built binary exists.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { nextUnitId } from "./association.js";
import {
  ControlError,
  attemptFor,
  dispatchControl,
  listControlRecords,
  runFor,
  savedPathFor,
  scanAttempts,
  textHunks,
  type CaptureRecord,
  type ControlContext,
} from "./controls.js";
import { hashInput, readFence } from "./lifecycle.js";
import { createMcpSession, type McpSession } from "./mcp.js";
import { PreflightError, type McpRole } from "./protocol.js";
import { readJournal, stageJournal, markCommitted, unresolvedJournals } from "./journal.js";
import { acquire } from "./leases.js";
import { parseUnitRecord, sha256HexText } from "./records.js";
import { AppAcceptanceError } from "./acceptance.js";

const FIXED_NOW = 1798765432100;
const nowStub = (): number => FIXED_NOW;
const noopPreflight = (): void => {};

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bgi12-"));
}

async function writeTree(root: string, files: [string, string][]): Promise<void> {
  for (const [rel, text] of files) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, text);
  }
}

/** Preserve membership and every byte, including unit metadata. */
function currentBytes(root: string): [string, string][] {
  const files: [string, string][] = [];
  const base = join(root, "can.generated");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push([relative(base, path), readFileSync(path).toString("hex")]);
    }
  };
  if (existsSync(base)) walk(base);
  return files.sort(([a], [b]) => a.localeCompare(b));
}

async function writeFake(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n${body}`);
  await chmod(path, 0o755);
  return path;
}

/**
 * Fake runner: waits for $SUBMIT_WAIT_N submissions (default: the
 * session binding's allowed count), then reports a clean structured
 * exit with a recorded thread id.
 */
const WAIT_FAKE = `
const fs = require("node:fs");
const path = require("node:path");
process.chdir(path.dirname(process.env.CAN_GENERATION_SESSION_FILE));
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", async () => {
  let want = Number(process.env.SUBMIT_WAIT_N ?? Number.NaN);
  if (!Number.isInteger(want) || want < 0) {
    try {
      const binding = JSON.parse(fs.readFileSync("session.json", "utf8"));
      want = binding.allowed;
    } catch { want = 1; }
  }
  for (let i = 0; i < 400; i += 1) {
    let found = 0;
    try {
      for (const entry of fs.readdirSync("candidates")) {
        try { fs.statSync("candidates/" + entry + "/submission.json"); found += 1; } catch {}
      }
    } catch {}
    if (found >= want) {
      console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-1" }));
      console.log(JSON.stringify({ status: "ok" }));
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  process.stderr.write("timed out waiting for " + want + " submissions\\n");
  process.exit(1);
});
`;

const APP = `app Tasks
Given
 trait completable $"Add done:bool=false."
When
Then
 style TaskSurface $"Readable task surfaces."
 style EntryArea $"A compact entry area."
`;

interface FakeDescriptor {
  owner: string;
  kind: string;
  label: string | null;
  anchor: string;
  prompt: string;
  profile: string | null;
  target: string | null;
  signature: string | null;
  span: { start: number; end: number };
}

function styleDescriptor(label: string, prompt: string, start: number, end: number): FakeDescriptor {
  return {
    owner: "Tasks",
    kind: "style",
    label,
    anchor: `style ${label}`,
    prompt,
    profile: null,
    target: null,
    signature: null,
    span: { start, end },
  };
}

function envelope(request_id: string, operation: string, ok: boolean, state: string, payload: Record<string, unknown>, next: string[]): string {
  return `${JSON.stringify({ version: 1, request_id, operation, ok, state, ...payload, next })}\n`;
}

function okEnvelope(request_id: string, operation: string, state: string, payload: Record<string, unknown>): string {
  return envelope(request_id, operation, true, state, payload, []);
}

function errorEnvelope(request_id: string, operation: string, code: string, message: string): string {
  return envelope(request_id, operation, false, "error", { error: { code, message } }, []);
}

/**
 * Disk-backed fake compiler: canned descriptors per file, real
 * association against on-disk unit.json records, real bind writes,
 * and scriptable validation. Complex enough to run capture through
 * acceptance end to end; the journal/lease/fence layers stay real.
 */
class FakeCompiler {
  descriptors = new Map<string, FakeDescriptor[]>();
  calls: { operation: string; request: Record<string, unknown> }[] = [];
  failValidateUnits = new Map<string, string>();
  failValidateFiles: string | null = null;
  requireDeclarationFor: Set<string> = new Set();

  compiler = async (requestJson: string): Promise<{ code: number; stdout: string }> => {
    const request = JSON.parse(requestJson) as Record<string, unknown>;
    const operation = request["operation"] as string;
    this.calls.push({ operation, request });
    switch (operation) {
      case "status":
        return this.status(request);
      case "bind":
        return this.bind(request);
      case "validate":
        return this.validate(request);
      case "inspect":
        return {
          code: 0,
          stdout: okEnvelope(request["request_id"] as string, "inspect", "reported", {
            unit: { id: "u9", kind: "style" },
            recipe: null,
            recipe_error: null,
          }),
        };
      default:
        return { code: 2, stdout: errorEnvelope(request["request_id"] as string, operation, "unknown-operation", "fake refuses") };
    }
  };

  /** Descriptor key for a compiler file operand (root-relative when inside). */
  private keyFor(root: string, file: string): string {
    const abs = resolve(root, file);
    const rel = relative(resolve(root), abs);
    if (rel.length === 0 || rel.startsWith("..") || resolve(root, rel) !== abs) return file;
    return rel.split(sep).join("/");
  }

  private savedRecords(root: string): { id: string; record: ReturnType<typeof parseUnitRecord> }[] {
    const out: { id: string; record: ReturnType<typeof parseUnitRecord> }[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(join(root, "can.generated"));
    } catch {
      return out;
    }
    for (const name of names.sort()) {
      try {
        const text = readFileSync(join(root, "can.generated", name, "unit.json"), "utf8") as string;
        out.push({ id: name, record: parseUnitRecord(text, name) });
      } catch {
        // Unparseable records are invisible to fake association.
      }
    }
    return out;
  }

  private status(request: Record<string, unknown>): { code: number; stdout: string } {
    const root = request["root"] as string;
    const files = request["files"] as string[];
    const request_id = request["request_id"] as string;
    const saved = this.savedRecords(root);
    const units: unknown[] = [];
    const matched = new Set<string>();
    for (const file of files) {
      for (const descriptor of this.descriptors.get(this.keyFor(root, file)) ?? []) {
        const key = JSON.stringify([descriptor.owner, descriptor.kind, descriptor.label, descriptor.anchor]);
        const group = saved.filter((entry) => {
          const source = entry.record.source;
          return JSON.stringify([source.owner, source.kind, source.label, source.anchor]) === key;
        });
        const contract = {
          target: descriptor.target,
          profile: descriptor.profile,
          prompt_sha256: sha256HexText(descriptor.prompt),
          signature: descriptor.signature,
        };
        if (group.length === 0) {
          units.push({
            id: null,
            owner: descriptor.owner,
            kind: descriptor.kind,
            label: descriptor.label,
            path: file,
            association: "new",
            prompt: descriptor.prompt,
            contract,
            span: descriptor.span,
            action: "generate",
          });
        } else if (group.length === 1) {
          const only = group[0] as { id: string; record: ReturnType<typeof parseUnitRecord> };
          matched.add(only.id);
          units.push({
            id: only.id,
            owner: descriptor.owner,
            kind: descriptor.kind,
            label: descriptor.label,
            path: file,
            association: "retained",
            prompt: descriptor.prompt,
            contract,
            span: descriptor.span,
            prompt_changed: sha256HexText(descriptor.prompt) !== only.record.contract.prompt_sha256,
            current: `${root}/can.generated/${only.id}`,
            candidates: `${root}/.can/gen/attempts/${only.id}`,
          });
        } else {
          units.push({
            id: null,
            owner: descriptor.owner,
            kind: descriptor.kind,
            label: descriptor.label,
            path: file,
            association: "ambiguous",
            prompt: descriptor.prompt,
            contract,
            span: descriptor.span,
            candidates: group.map((entry) => entry.id).sort(),
            action: "bind",
          });
        }
      }
    }
    for (const entry of saved) {
      if (matched.has(entry.id)) continue;
      units.push({ id: entry.id, association: "orphaned", prompt: null, contract: null, span: null, action: "bind" });
    }
    return { code: 0, stdout: okEnvelope(request_id, "status", "reported", { units, issues: [] }) };
  }

  private bind(request: Record<string, unknown>): { code: number; stdout: string } {
    const root = request["root"] as string;
    const request_id = request["request_id"] as string;
    const file = request["file"] as string;
    const start = request["start"] as number;
    const end = request["end"] as number;
    const revision = request["revision"] as string;
    const unit = request["unit"] as string;
    let text: string;
    try {
      text = readFileSync(resolve(root, file), "utf8") as string;
    } catch {
      return { code: 2, stdout: errorEnvelope(request_id, "bind", "unreadable-input", "fake cannot read the source") };
    }
    if (sha256HexText(text) !== revision) {
      return { code: 2, stdout: errorEnvelope(request_id, "bind", "stale-selector", "fake inspected revision is stale") };
    }
    const descriptor = (this.descriptors.get(this.keyFor(root, file)) ?? []).find(
      (candidate) => candidate.span.start === start && candidate.span.end === end,
    );
    if (descriptor === undefined) {
      return { code: 2, stdout: errorEnvelope(request_id, "bind", "no-unit-at-span", "fake found no unit at the span") };
    }
    const saved = this.savedRecords(root);
    const contract = {
      target: descriptor.target,
      profile: descriptor.profile,
      prompt_sha256: sha256HexText(descriptor.prompt),
      signature: descriptor.signature,
    };
    if (unit === "new") {
      const id = nextUnitId(saved.map((entry) => entry.id));
      const record = {
        abi_version: 1,
        id,
        source: {
          owner: descriptor.owner,
          kind: descriptor.kind,
          label: descriptor.label,
          anchor: descriptor.anchor,
          path: file,
          revision,
          start,
          end,
        },
        contract,
        original: { prompt_sha256: sha256HexText(descriptor.prompt), files: {} },
        provenance: { origin: "bound", runner: null, model: null, note: "fake explicit bind" },
      };
      mkdirSync(join(root, "can.generated", id), { recursive: true });
      writeFileSync(join(root, "can.generated", id, "unit.json"), `${JSON.stringify(record, null, 2)}\n`);
      return {
        code: 0,
        stdout: okEnvelope(request_id, "bind", "bound", {
          unit: { id, path: join(root, "can.generated", id, "unit.json"), owner: descriptor.owner, kind: descriptor.kind, label: descriptor.label, contract },
        }),
      };
    }
    const prior = saved.find((entry) => entry.id === unit);
    if (prior === undefined) {
      return { code: 2, stdout: errorEnvelope(request_id, "bind", "unknown-unit", `fake holds no saved unit ${JSON.stringify(unit)}`) };
    }
    return {
      code: 0,
      stdout: okEnvelope(request_id, "bind", "bound", {
        unit: { id: unit, path: join(root, "can.generated", unit, "unit.json"), owner: descriptor.owner, kind: descriptor.kind, label: descriptor.label, contract },
      }),
    };
  }

  private validate(request: Record<string, unknown>): { code: number; stdout: string } {
    const root = request["root"] as string;
    const request_id = request["request_id"] as string;
    if (typeof request["unit_id"] === "string") {
      const unit = request["unit_id"] as string;
      const failure = this.failValidateUnits.get(unit);
      if (failure !== undefined) {
        return { code: 4, stdout: errorEnvelope(request_id, "validate", "validation-failure", failure) };
      }
      let record: ReturnType<typeof parseUnitRecord>;
      try {
        record = parseUnitRecord(readFileSync(join(root, "can.generated", unit, "unit.json"), "utf8") as string, unit);
      } catch {
        return { code: 4, stdout: errorEnvelope(request_id, "validate", "validation-failure", `fake: unit ${unit} record is incompatible`) };
      }
      if (this.requireDeclarationFor.has(unit) && !existsSync(join(root, "can.generated", unit, "declaration.json"))) {
        return {
          code: 4,
          stdout: errorEnvelope(request_id, "validate", "validation-failure", `unit \`${unit}\` declares no saved interface: \`declaration.json\` is missing; reconcile the interface with adopt`),
        };
      }
      const primaries: Record<string, string[]> = {
        style: ["style.css"],
        "style-inline": ["style.css"],
        "view-style-inline": ["style.css"],
        "named-trait": ["contributions.can"],
        "inline-trait": ["contributions.can"],
        keyword: ["implementation.js"],
        view: ["implementation.js"],
      };
      for (const primary of primaries[record.source.kind] ?? []) {
        if (!existsSync(join(root, "can.generated", unit, primary))) {
          return { code: 4, stdout: errorEnvelope(request_id, "validate", "validation-failure", `fake: unit ${unit} is missing required primary output \`${primary}\``) };
        }
      }
      const first = (primaries[record.source.kind] ?? [])[0] as string;
      const fingerprint = sha256HexText(readFileSync(join(root, "can.generated", unit, first), "utf8") as string);
      return {
        code: 0,
        stdout: okEnvelope(request_id, "validate", "validated", {
          unit_id: unit,
          kind: record.source.kind,
          checks: [{ name: "fake-presence", ok: true, detail: "primaries present" }],
          inputs: { source: { path: record.source.path, revision: "fake" }, files: [] },
          fingerprint,
          modified_since_generation: false,
          prompt_changed: false,
        }),
      };
    }
    if (this.failValidateFiles !== null) {
      return { code: 4, stdout: errorEnvelope(request_id, "validate", "validation-failure", this.failValidateFiles) };
    }
    const files = (request["files"] as string[]) ?? [];
    for (const file of files) {
      if (!existsSync(resolve(root, file))) {
        return { code: 4, stdout: errorEnvelope(request_id, "validate", "validation-failure", `fake: scope file \`${file}\` is missing`) };
      }
    }
    return {
      code: 0,
      stdout: okEnvelope(request_id, "validate", "validated", {
        files: files.map((file) => ({ path: file, checks: [{ name: "fake-bytes", ok: true, detail: "bytes read" }] })),
        inputs: { files: [] },
      }),
    };
  }
}

function contentFor(role: string, handle: string): { text: string } | { base64: string } {
  switch (role) {
    case "style":
      return { text: `/* ${handle} */\n.root {\n  color: red;\n}\n` };
    case "server":
      return { text: `export function main() {\n  return ${JSON.stringify(handle)};\n}\n` };
    case "browser":
      return { text: `export function mount() {\n  return ${JSON.stringify(handle)};\n}\n` };
    case "contributions":
      return { text: `## ${handle}\nGiven\n` };
    default:
      return { base64: Buffer.from(`asset:${handle}`, "utf8").toString("base64") };
  }
}

/** Submit canned content for every allowed handle except skipped ones. */
function submitAll(skips: ReadonlySet<string> = new Set()): (session: McpSession) => void {
  return (session: McpSession) => {
    const batch = [];
    for (const target of session.context().allowed) {
      if (skips.has(target.handle)) continue;
      const content = contentFor(target.role, target.handle);
      if ("text" in content) {
        batch.push({ target: target.handle, role: target.role, content_text: content.text });
      } else {
        batch.push({ target: target.handle, role: target.role, content_base64: content.base64 });
      }
    }
    if (batch.length > 0) {
      void session.submit(session.id, batch);
    }
  };
}

function req(request_id: string, operation: string, params: Record<string, unknown>): string {
  return JSON.stringify({ version: 1, request_id, operation, ...params });
}

function bodyOf(envelope: string): Record<string, unknown> {
  return JSON.parse(envelope) as Record<string, unknown>;
}

interface Harness {
  root: string;
  fake: FakeCompiler;
  runner: string;
}

async function harness(files: [string, string][] = [["app.can", APP]]): Promise<Harness> {
  const root = await freshRoot();
  await writeTree(root, files);
  const fake = new FakeCompiler();
  const runner = await writeFake(root, "fake-runner", WAIT_FAKE);
  return { root, fake, runner };
}

function ctxFor(harness: Harness, overrides: Partial<ControlContext> = {}): ControlContext {
  return {
    compiler: harness.fake.compiler,
    appAcceptance: async () => {},
    now: nowStub,
    preflight: noopPreflight,
    resolveExecutable: async () => harness.runner,
    onSession: submitAll(),
    // Explicit no-transport: these fake-runner flows submit through
    // the session hook; the production bridge has its own tests.
    mcpBridge: null,
    ...overrides,
  };
}

const RECIPE = { runner: "codex", model: "test-model" };

function twoStyles(): FakeDescriptor[] {
  return [
    styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160),
    styleDescriptor("EntryArea", "A compact entry area.", 200, 260),
  ];
}

test("retry captures every prompt including preferred outputs", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  const result = await dispatchControl(
    req("r-retry", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(result.code, 0);
  const body = bodyOf(result.envelope);
  assert.equal(body["ok"], true);
  assert.equal(body["state"], "candidate");
  assert.equal(body["qualified"], false);
  assert.equal(body["accepted"], false);
  const attempts = body["attempts"] as { attempt: string; units: string[] }[];
  assert.equal(attempts.length, 1);
  assert.deepEqual([...(attempts[0]?.units ?? [])].sort(), ["u1", "u2"]);
  // Both units bound through the compiler with real association evidence.
  for (const id of ["u1", "u2"]) {
    const record = parseUnitRecord(await readFile(join(h.root, "can.generated", id, "unit.json"), "utf8"), id);
    assert.equal(record.provenance.origin, "bound");
    assert.ok(record.source.anchor.length > 0);
  }
  // The capture froze both prompts plus source revisions.
  const capture = JSON.parse(await readFile(join(h.root, ".can/gen/attempts", attempts[0]?.attempt as string, "capture.json"), "utf8")) as CaptureRecord;
  assert.equal(capture.units.length, 2);
  assert.deepEqual(capture.units.map((unit) => unit.prompt).sort(), ["A compact entry area.", "Readable task surfaces."]);
  assert.equal(capture.source_revisions[join(h.root, "app.can")], sha256HexText(APP));
  assert.equal(capture.fence, 0);
});

test("generate prepare skips fresh units and reports them", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  // First pass binds both units; accept them so the second pass finds fresh output.
  const first = await dispatchControl(
    req("r-prep1", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(first.code, 0, first.envelope);
  assert.equal(bodyOf(first.envelope)["state"], "accepted");
  const second = await dispatchControl(
    req("r-prep2", "generate", { root: h.root, files: ["app.can"], mode: "prepare", accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(second.code, 0, second.envelope);
  const body = bodyOf(second.envelope);
  assert.equal(body["state"], "candidate");
  assert.deepEqual(body["attempts"], []);
  const skipped = body["skipped"] as { unit_id: string }[];
  assert.deepEqual(skipped.map((entry) => entry.unit_id).sort(), ["u1", "u2"]);
});

test("generate fresh regenerates every scoped unit", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  const first = await dispatchControl(
    req("r-fresh1", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(first.code, 0, first.envelope);
  const second = await dispatchControl(
    req("r-fresh2", "generate", { root: h.root, files: ["app.can"], mode: "fresh", ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(second.code, 0, second.envelope);
  const body = bodyOf(second.envelope);
  assert.deepEqual(body["skipped"], []);
  const attempts = body["attempts"] as { units: string[] }[];
  assert.equal(attempts.length, 1);
  assert.deepEqual([...(attempts[0]?.units ?? [])].sort(), ["u1", "u2"]);
});

test("generate unit_ids scope resolves through record plus status", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  const first = await dispatchControl(
    req("r-uid1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(first.code, 0, first.envelope);
  const second = await dispatchControl(
    req("r-uid2", "generate", { root: h.root, unit_ids: ["u2"], mode: "fresh", ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(second.code, 0, second.envelope);
  const attempts = bodyOf(second.envelope)["attempts"] as { units: string[] }[];
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0]?.units, ["u2"]);
  const unknown = await dispatchControl(
    req("r-uid3", "generate", { root: h.root, unit_ids: ["u99"], mode: "fresh", ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(unknown.code, 2);
  assert.equal((bodyOf(unknown.envelope)["error"] as { code: string }).code, "unknown-unit");
});

test("ambiguous scope refuses with the bind action", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  // Two records share one key: the scope cannot pick one.
  const bind = async (request_id: string): Promise<void> => {
    const revision = sha256HexText(APP);
    await dispatchControl(
      req(request_id, "bind", { root: h.root, file: "app.can", start: 100, end: 160, revision, unit: "new" }),
      ctxFor(h),
    );
  };
  await bind("r-amb-bind1");
  await bind("r-amb-bind2");
  const result = await dispatchControl(
    req("r-amb", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(result.code, 2);
  const error = bodyOf(result.envelope)["error"] as { code: string; message: string };
  assert.equal(error.code, "ambiguous-unit");
  assert.match(error.message, /bind/);
});

test("empty retry scope refuses", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", []);
  const result = await dispatchControl(
    req("r-empty", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(result.code, 2);
  assert.equal((bodyOf(result.envelope)["error"] as { code: string }).code, "empty-closure");
});

test("refine uses the current baseline plus each instruction carrier", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const seed = await dispatchControl(
    req("r-ref0", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(seed.code, 0, seed.envelope);
  const currentCss = await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8");
  // Inline carrier.
  const inline = await dispatchControl(
    req("r-ref1", "refine", { root: h.root, unit_id: "u1", instruction: "Darken the focus ring.", ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(inline.code, 0, inline.envelope);
  // File carrier.
  await writeFile(join(h.root, "change.txt"), "Widen the hit targets.");
  const viaFile = await dispatchControl(
    req("r-ref2", "refine", { root: h.root, unit_id: "u1", instruction_file: "change.txt", ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(viaFile.code, 0, viaFile.envelope);
  // Stdin carrier.
  const viaStdin = await dispatchControl(
    req("r-ref3", "refine", { root: h.root, unit_id: "u1", instruction_stdin: true, ...RECIPE }),
    ctxFor(h, { stdinText: "Soften the borders." }),
  );
  assert.equal(viaStdin.code, 0, viaStdin.envelope);
  // The refine prompt carried the live baseline, not a stale copy.
  const capture = JSON.parse(
    await readFile(join(h.root, ".can/gen/attempts", "r-ref1.j0", "capture.json"), "utf8"),
  ) as CaptureRecord;
  assert.equal(capture.mode, "refine");
  assert.equal(capture.instruction, "Darken the focus ring.");
  assert.ok(currentCss.includes("u1-style"));
  // Stdin carrier without a payload refuses.
  const missing = await dispatchControl(
    req("r-ref4", "refine", { root: h.root, unit_id: "u1", instruction_stdin: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(missing.code, 2);
  assert.equal((bodyOf(missing.envelope)["error"] as { code: string }).code, "exclusive-carrier");
});

test("refine without a current baseline refuses", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const revision = sha256HexText(APP);
  const bound = await dispatchControl(
    req("r-nb", "bind", { root: h.root, file: "app.can", start: 100, end: 160, revision, unit: "new" }),
    ctxFor(h),
  );
  assert.equal(bound.code, 0, bound.envelope);
  const result = await dispatchControl(
    req("r-nb-ref", "refine", { root: h.root, unit_id: "u1", instruction: "Change it.", ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(result.code, 2);
  assert.equal((bodyOf(result.envelope)["error"] as { code: string }).code, "no-current-baseline");
});

test("resend-same recovers without relaunch; changed input conflicts", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const params = { root: h.root, files: ["app.can"], ...RECIPE };
  const first = await dispatchControl(req("r-idem", "retry", params), ctxFor(h));
  assert.equal(first.code, 0, first.envelope);
  const spawns = h.fake.calls.filter((call) => call.operation === "status").length;
  const second = await dispatchControl(req("r-idem", "retry", params), ctxFor(h));
  assert.equal(second.code, 0);
  assert.equal(second.envelope, first.envelope);
  assert.equal(
    h.fake.calls.filter((call) => call.operation === "status").length,
    spawns,
    "resend must not recapture",
  );
  const changed = await dispatchControl(req("r-idem", "retry", { ...params, files: ["other.can"] }), ctxFor(h));
  assert.equal(changed.code, 3);
  assert.equal((bodyOf(changed.envelope)["error"] as { code: string }).code, "request-conflict");
});

test("malformed requests fail closed with echoed headers", async () => {
  const h = await harness();
  const bad = await dispatchControl(`{"version":1,"request_id":"r-bad","operation":"retry"}`, ctxFor(h));
  assert.equal(bad.code, 2);
  const body = bodyOf(bad.envelope);
  assert.equal(body["request_id"], "r-bad");
  assert.equal(body["operation"], "retry");
  const garbage = await dispatchControl(`not json`, ctxFor(h));
  assert.equal(garbage.code, 2);
  assert.equal(bodyOf(garbage.envelope)["operation"], "unknown");
});

test("doctor is not a control operation", async () => {
  const h = await harness();
  await assert.rejects(dispatchControl(req("r-doc", "doctor", { root: h.root }), ctxFor(h)), (error: unknown) => {
    assert.ok(error instanceof ControlError);
    assert.equal(error.code, "wrong-dispatcher");
    return true;
  });
});

test("accept promotes a complete set through one coordinated journal", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  const produced = await dispatchControl(
    req("r-acc1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const attempt = (bodyOf(produced.envelope)["attempts"] as { attempt: string }[])[0]?.attempt as string;
  const accepted = await dispatchControl(
    req("r-acc2", "accept", { root: h.root, attempt }),
    ctxFor(h),
  );
  assert.equal(accepted.code, 0, accepted.envelope);
  const body = bodyOf(accepted.envelope);
  assert.equal(body["state"], "accepted");
  assert.equal(body["qualified"], true);
  const run = body["run"] as string;
  // One journal carried both units; it resolved on commit.
  const journal = await readJournal(h.root, run).catch(() => null);
  assert.equal(journal, null);
  assert.deepEqual(await unresolvedJournals(h.root), []);
  // Current bytes equal the candidate bytes; the prior group is retained.
  for (const [id, handle] of [["u1", "u1-style"], ["u2", "u2-style"]] as const) {
    const current = await readFile(join(h.root, "can.generated", id, "style.css"), "utf8");
    assert.ok(current.includes(handle), current);
    const record = parseUnitRecord(await readFile(join(h.root, "can.generated", id, "unit.json"), "utf8"), id);
    assert.equal(record.provenance.origin, "generated");
    assert.equal(record.provenance.runner, "codex");
    assert.ok((record.original.files["style.css"] as string).length > 0);
  }
  const previous = await readFile(join(h.root, ".can/gen/previous", "u1", "unit.json"), "utf8");
  assert.equal((JSON.parse(previous) as { provenance: { origin: string } }).provenance.origin, "bound");
  // The consumed attempt fenced and recorded its acceptance.
  assert.equal(await readFence(join(h.root, ".can/gen/attempts", attempt)), 1);
  const marker = JSON.parse(await readFile(join(h.root, ".can/gen/attempts", attempt, "accepted.json"), "utf8")) as { run: string };
  assert.equal(marker.run, run);
  // No stray leases remain.
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(join(h.root, ".can/gen/locks")), []);
});

test("accept unit scope serves single-unit attempts only", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const produced = await dispatchControl(
    req("r-au1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const accepted = await dispatchControl(
    req("r-au2", "accept", { root: h.root, unit_id: "u1" }),
    ctxFor(h),
  );
  assert.equal(accepted.code, 0, accepted.envelope);
  assert.equal(bodyOf(accepted.envelope)["state"], "accepted");
  assert.ok((await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8")).includes("u1-style"));
});

test("accept unit scope refuses partial acceptance of a full set", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  const produced = await dispatchControl(
    req("r-ap1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const refused = await dispatchControl(
    req("r-ap2", "accept", { root: h.root, unit_id: "u1" }),
    ctxFor(h),
  );
  assert.equal(refused.code, 2);
  assert.equal((bodyOf(refused.envelope)["error"] as { code: string }).code, "full-set-required");
  // Nothing promoted: no current CSS, no journal.
  await assert.rejects(readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8"));
  assert.deepEqual(await unresolvedJournals(h.root), []);
});

test("incomplete sets stay candidates and preserve everything", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  const partialRunner = await writeFake(h.root, "fake-partial-runner", WAIT_FAKE.replace("let want = Number(process.env.SUBMIT_WAIT_N ?? Number.NaN);", "let want = 3;"));
  {
    const produced = await dispatchControl(
      req("r-inc1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
      ctxFor(h, { onSession: submitAll(new Set(["u2-style"])), resolveExecutable: async () => partialRunner }),
    );
    assert.equal(produced.code, 0, produced.envelope);
    assert.equal(bodyOf(produced.envelope)["complete"], false);
  }
  const attempt = "r-inc1.j0";
  const refused = await dispatchControl(
    req("r-inc2", "accept", { root: h.root, attempt }),
    ctxFor(h),
  );
  assert.equal(refused.code, 4);
  const error = bodyOf(refused.envelope)["error"] as { code: string; message: string };
  assert.equal(error.code, "incomplete-set");
  assert.match(error.message, /u2-style/);
  // The submitted candidates stay inspectable; current files are untouched.
  const inventory = JSON.parse(
    await readFile(join(h.root, ".can/gen/attempts", attempt, "candidates", "u1-style", "submission.json"), "utf8"),
  ) as { handle: string };
  assert.equal(inventory.handle, "u1-style");
  await assert.rejects(readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8"));
});

test("participating edits between capture and accept conflict", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const produced = await dispatchControl(
    req("r-pe1", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const second = await dispatchControl(
    req("r-pe2", "generate", { root: h.root, files: ["app.can"], mode: "fresh", ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(second.code, 0, second.envelope);
  const attempt = (bodyOf(second.envelope)["attempts"] as { attempt: string }[])[0]?.attempt as string;
  // A participating author edits the current CSS before acceptance.
  await writeFile(join(h.root, "can.generated", "u1", "style.css"), "/* author edit */\n.a{color:blue}\n");
  const refused = await dispatchControl(req("r-pe3", "accept", { root: h.root, attempt }), ctxFor(h));
  assert.equal(refused.code, 3);
  const error = bodyOf(refused.envelope)["error"] as { code: string; message: string };
  assert.equal(error.code, "current-changed");
  assert.match(error.message, /preserved/);
  // The newer work and the candidate both survive.
  assert.equal(await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8"), "/* author edit */\n.a{color:blue}\n");
  assert.ok((await readFile(join(h.root, ".can/gen/attempts", attempt, "candidates", "u1-style", "style.css"), "utf8")).includes("u1-style"));
});

test("source changes between capture and accept conflict", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const produced = await dispatchControl(
    req("r-sc1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const attempt = (bodyOf(produced.envelope)["attempts"] as { attempt: string }[])[0]?.attempt as string;
  await writeFile(join(h.root, "app.can"), `${APP}## edited\n`);
  const refused = await dispatchControl(req("r-sc2", "accept", { root: h.root, attempt }), ctxFor(h));
  assert.equal(refused.code, 3);
  assert.equal((bodyOf(refused.envelope)["error"] as { code: string }).code, "source-changed");
});

test("cancelled attempts cannot late-accept", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const produced = await dispatchControl(
    req("r-ca1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const attempt = (bodyOf(produced.envelope)["attempts"] as { attempt: string }[])[0]?.attempt as string;
  const cancelled = await dispatchControl(
    req("r-ca2", "cancel", { root: h.root, request: "r-ca1" }),
    ctxFor(h),
  );
  assert.equal(cancelled.code, 0, cancelled.envelope);
  const refused = await dispatchControl(req("r-ca3", "accept", { root: h.root, attempt }), ctxFor(h));
  assert.equal(refused.code, 3);
  assert.equal((bodyOf(refused.envelope)["error"] as { code: string }).code, "attempt-fenced");
});

test("accept true composes the full flow through one journal", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  let gateCalls = 0;
  const result = await dispatchControl(
    req("r-ct1", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h, { appAcceptance: async input => {
      gateCalls += 1;
      assert.equal(input.root, h.root);
      assert.notEqual(input.candidateRoot, h.root);
      assert.deepEqual(input.files, ["app.can"]);
      assert.equal(await readFile(join(input.candidateRoot, "app.can"), "utf8"), APP);
      for (const unit of ["u1", "u2"]) {
        assert.match(await readFile(join(input.candidateRoot, "can.generated", unit, "style.css"), "utf8"), new RegExp(`${unit}-style`));
        assert.equal(existsSync(join(h.root, "can.generated", unit, "style.css")), false, "current must remain unpromoted during app checks");
        assert.equal(parseUnitRecord(await readFile(join(h.root, "can.generated", unit, "unit.json"), "utf8"), unit).provenance.origin, "bound");
      }
      assert.deepEqual(await unresolvedJournals(h.root), []);
    } }),
  );
  assert.equal(gateCalls, 1);
  assert.equal(result.code, 0, result.envelope);
  const body = bodyOf(result.envelope);
  assert.equal(body["state"], "accepted");
  assert.equal(body["qualified"], true);
  const accepted = body["accepted"] as { run: string; units: string[] };
  assert.deepEqual([...accepted.units].sort(), ["u1", "u2"]);
  assert.deepEqual(await unresolvedJournals(h.root), []);
  assert.ok((await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8")).includes("u1-style"));
  assert.ok((await readFile(join(h.root, "can.generated", "u2", "style.css"), "utf8")).includes("u2-style"));
});

for (const stage of ["build", "test", "playwright"]) {
  test(`manual accept preserves the complete current set and candidates when ${stage} fails`, async () => {
    const h = await harness();
    try {
      h.fake.descriptors.set("app.can", twoStyles());
      const seeded = await dispatchControl(req(`gate-${stage}-seed`, "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }), ctxFor(h));
      assert.equal(seeded.code, 0, seeded.envelope);
      await writeTree(h.root, [["can.generated/u1/style.css", ".prior-one {color:blue}"], ["can.generated/u2/style.css", ".prior-two {color:green}"]]);
      const produced = await dispatchControl(req(`gate-${stage}-candidate`, "retry", { root: h.root, files: ["app.can"], ...RECIPE }), ctxFor(h, {
        appAcceptance: async () => { assert.fail("candidate generation must not run app acceptance"); },
      }));
      assert.equal(produced.code, 0, produced.envelope);
      const attempt = (bodyOf(produced.envelope).attempts as { attempt: string }[])[0]!.attempt;
      const attemptDir = join(h.root, ".can/gen/attempts", attempt);
      const candidates = await Promise.all(["u1", "u2"].map(unit => readFile(join(attemptDir, "candidates", `${unit}-style`, "style.css"))));
      const before = currentBytes(h.root);
      let gateCalls = 0;
      const requestId = `gate-${stage}-accept`;
      const refused = await dispatchControl(req(requestId, "accept", { root: h.root, attempt }), ctxFor(h, {
        appAcceptance: async input => {
          gateCalls += 1;
          assert.deepEqual(currentBytes(h.root), before);
          for (const [index, unit] of ["u1", "u2"].entries()) {
            assert.deepEqual(await readFile(join(input.candidateRoot, "can.generated", unit, "style.css")), candidates[index]);
          }
          throw new AppAcceptanceError(stage, "check failure sentinel");
        },
      }));
      assert.equal(gateCalls, 1);
      assert.equal(refused.code, 4, refused.envelope);
      const error = bodyOf(refused.envelope).error as { code: string; message: string };
      assert.equal(error.code, "app-acceptance-failed");
      assert.match(error.message, new RegExp(`${stage}: check failure sentinel`));
      assert.deepEqual(currentBytes(h.root), before);
      for (const [index, unit] of ["u1", "u2"].entries()) {
        assert.deepEqual(await readFile(join(attemptDir, "candidates", `${unit}-style`, "style.css")), candidates[index]);
      }
      assert.equal(await readFence(attemptDir), 0);
      assert.equal(existsSync(join(attemptDir, "accepted.json")), false);
      assert.equal(existsSync(join(h.root, ".can/gen/runs", runFor("run", requestId), "journal.json")), false);
      assert.equal(existsSync(join(h.root, ".can/gen/runs", runFor("run", requestId), "journal.resolved.json")), false);
      assert.deepEqual(await unresolvedJournals(h.root), []);
    } finally { await rm(h.root, { recursive: true, force: true }); }
  });
}

test("accept refuses a candidate overlay altered by the app check hook", async () => {
  const h = await harness();
  try {
    h.fake.descriptors.set("app.can", twoStyles());
    const produced = await dispatchControl(req("gate-mutation-candidate", "retry", { root: h.root, files: ["app.can"], ...RECIPE }), ctxFor(h));
    assert.equal(produced.code, 0, produced.envelope);
    const attempt = (bodyOf(produced.envelope).attempts as { attempt: string }[])[0]!.attempt;
    const before = currentBytes(h.root);
    const candidatePath = join(h.root, ".can/gen/attempts", attempt, "candidates/u1-style/style.css");
    const candidate = await readFile(candidatePath);
    const refused = await dispatchControl(req("gate-mutation-accept", "accept", { root: h.root, attempt }), ctxFor(h, {
      appAcceptance: async input => { await writeFile(join(input.candidateRoot, "can.generated/u1/style.css"), ".tampered {}\n"); },
    }));
    assert.equal(refused.code, 4, refused.envelope);
    const error = bodyOf(refused.envelope).error as { code: string; message: string };
    assert.equal(error.code, "app-acceptance-failed");
    assert.match(error.message, /inputs: candidate inputs changed during checks/);
    assert.deepEqual(currentBytes(h.root), before);
    assert.deepEqual(await readFile(candidatePath), candidate);
    assert.deepEqual(await unresolvedJournals(h.root), []);
    assert.equal(existsSync(join(h.root, ".can/gen/attempts", attempt, "accepted.json")), false);
  } finally { await rm(h.root, { recursive: true, force: true }); }
});

test("accept refuses an authored interface changed while app checks run", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  const seeded = await dispatchControl(req("interface-seed", "retry", {
    root: h.root, files: ["app.can"], accept: true, ...RECIPE,
  }), ctxFor(h));
  assert.equal(seeded.code, 0, seeded.envelope);
  const current = await readFile(join(h.root, "can.generated/u1/style.css"), "utf8");
  const result = await dispatchControl(req("interface-race", "retry", {
    root: h.root, files: ["app.can"], accept: true, ...RECIPE,
  }), ctxFor(h, { appAcceptance: async () => {
    await writeFile(join(h.root, "can.generated/u1/declaration.json"), '{"changed":true}\n');
  } }));
  assert.equal(result.code, 3, result.envelope);
  assert.equal((bodyOf(result.envelope).error as { code: string }).code, "interface-changed");
  assert.equal(await readFile(join(h.root, "can.generated/u1/style.css"), "utf8"), current);
  assert.deepEqual(await unresolvedJournals(h.root), []);
});

test("accept true with an incomplete set stays a candidate", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  const partialRunner = await writeFake(h.root, "fake-partial-runner", WAIT_FAKE.replace("let want = Number(process.env.SUBMIT_WAIT_N ?? Number.NaN);", "let want = 3;"));
  {
    const result = await dispatchControl(
      req("r-ci1", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
      ctxFor(h, { onSession: submitAll(new Set(["u2-style"])), resolveExecutable: async () => partialRunner }),
    );
    assert.equal(result.code, 0, result.envelope);
    const body = bodyOf(result.envelope);
    assert.equal(body["state"], "candidate");
    assert.equal(body["accepted"], false);
    assert.equal(body["complete"], false);
  }
  assert.deepEqual(await unresolvedJournals(h.root), []);
});

test("validation failure preserves candidates and current files", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  h.fake.failValidateUnits.set("u1", "fake: the CSS does not scope");
  const produced = await dispatchControl(
    req("r-vf1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const attempt = (bodyOf(produced.envelope)["attempts"] as { attempt: string }[])[0]?.attempt as string;
  const refused = await dispatchControl(req("r-vf2", "accept", { root: h.root, attempt }), ctxFor(h));
  assert.equal(refused.code, 4);
  const error = bodyOf(refused.envelope)["error"] as { code: string; message: string };
  assert.equal(error.code, "validation-failure");
  assert.match(error.message, /does not scope/);
  assert.match(error.message, /preserved/);
  assert.ok((await readFile(join(h.root, ".can/gen/attempts", attempt, "candidates", "u1-style", "style.css"), "utf8")).includes("u1-style"));
  await assert.rejects(readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8"));
  assert.deepEqual(await unresolvedJournals(h.root), []);
});

test("server role promotes to the intake primary", async () => {
  assert.equal(savedPathFor("server", "server.js"), "implementation.js");
  assert.equal(savedPathFor("browser", "browser.js"), "browser.js");
  assert.equal(savedPathFor("style", "style.css"), "style.css");
  assert.equal(savedPathFor("contributions", "contributions.can"), "contributions.can");
  assert.equal(savedPathFor("asset", "asset.bin"), "asset.bin");
  const h = await harness();
  h.fake.descriptors.set("app.can", [
    {
      owner: "Tasks",
      kind: "view",
      label: "TaskTile",
      anchor: "view TaskTile",
      prompt: "Arrange the tile.",
      profile: null,
      target: "Todo",
      signature: null,
      span: { start: 10, end: 60 },
    },
  ]);
  const produced = await dispatchControl(
    req("r-srv1", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  assert.equal(bodyOf(produced.envelope)["state"], "accepted");
  const implementation = await readFile(join(h.root, "can.generated", "u1", "implementation.js"), "utf8");
  assert.ok(implementation.includes("u1-server"), implementation);
  await assert.rejects(readFile(join(h.root, "can.generated", "u1", "server.js"), "utf8"));
});

test("keyword units reconcile declaration.json through adopt", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [
    {
      owner: "Tasks",
      kind: "keyword",
      label: "canonical_identity",
      anchor: "keyword canonical_identity",
      prompt: "Use NFKC keys.",
      profile: null,
      target: "Account",
      signature: "target:model,field:field(target,text)",
      span: { start: 10, end: 80 },
    },
  ]);
  h.fake.requireDeclarationFor.add("u1");
  const produced = await dispatchControl(
    req("r-kw1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const attempt = (bodyOf(produced.envelope)["attempts"] as { attempt: string }[])[0]?.attempt as string;
  // No declaration exists yet: acceptance routes to adopt.
  const refused = await dispatchControl(req("r-kw2", "accept", { root: h.root, attempt }), ctxFor(h));
  assert.equal(refused.code, 4);
  assert.match((bodyOf(refused.envelope)["error"] as { message: string }).message, /adopt/);
  // The authoring agent authors the interface metadata directly (no AI call).
  await writeFile(
    join(h.root, "can.generated", "u1", "declaration.json"),
    JSON.stringify({ producer: "state.unique-key@1", export: "main", reads: [], effects: [], authority: [] }),
  );
  const adopted = await dispatchControl(
    req("r-kw3", "adopt", { root: h.root, unit_id: "u1", files: ["can.generated/u1/declaration.json"] }),
    ctxFor(h, {
      preflight: () => { throw new Error("adopt must not launch"); },
      resolveExecutable: async () => { throw new Error("adopt must not launch"); },
    }),
  );
  assert.equal(adopted.code, 0, adopted.envelope);
  assert.equal(bodyOf(adopted.envelope)["state"], "adopted");
  // The preserved candidate now validates against the declared interface.
  const accepted = await dispatchControl(req("r-kw4", "accept", { root: h.root, attempt }), ctxFor(h));
  assert.equal(accepted.code, 0, accepted.envelope);
  assert.equal(bodyOf(accepted.envelope)["state"], "accepted");
  assert.ok((await readFile(join(h.root, "can.generated", "u1", "implementation.js"), "utf8")).includes("u1-server"));
});

test("adopt reconciles repaired source with adopted provenance", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const seed = await dispatchControl(
    req("r-ad0", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(seed.code, 0, seed.envelope);
  // Repair the source and the implementation by hand (no AI).
  await writeFile(join(h.root, "app.can"), `${APP}## repaired\n`);
  await writeFile(join(h.root, "can.generated", "u1", "style.css"), "/* repaired */\n.fixed{color:green}\n");
  const adopted = await dispatchControl(
    req("r-ad1", "adopt", { root: h.root, unit_id: "u1", files: ["can.generated/u1/style.css"] }),
    ctxFor(h, {
      preflight: () => { throw new Error("adopt must not launch"); },
      resolveExecutable: async () => { throw new Error("adopt must not launch"); },
    }),
  );
  assert.equal(adopted.code, 0, adopted.envelope);
  assert.equal(bodyOf(adopted.envelope)["state"], "adopted");
  const record = parseUnitRecord(await readFile(join(h.root, "can.generated", "u1", "unit.json"), "utf8"), "u1");
  assert.equal(record.provenance.origin, "adopted");
  assert.equal(record.provenance.runner, null);
  assert.equal(record.source.revision, sha256HexText(`${APP}## repaired\n`));
  // The historical generation fingerprints stay: the repair is marked modified.
  assert.notEqual(record.original.files["style.css"], sha256HexText("/* repaired */\n.fixed{color:green}\n"));
  // Adopt outside the unit's group refuses.
  const outside = await dispatchControl(
    req("r-ad2", "adopt", { root: h.root, unit_id: "u1", files: ["app.can"] }),
    ctxFor(h),
  );
  assert.equal(outside.code, 2);
});

test("compatible direct edits build with no adoption ceremony", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const seed = await dispatchControl(
    req("r-de0", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(seed.code, 0, seed.envelope);
  // A compatible direct edit validates through the files scope; no adopt call exists.
  await writeFile(join(h.root, "can.generated", "u1", "style.css"), "/* tweaked */\n.root{color:red}\n");
  const validated = await dispatchControl(
    req("r-de1", "validate", { root: h.root, files: ["can.generated/u1/style.css"] }),
    ctxFor(h),
  );
  assert.equal(validated.code, 0, validated.envelope);
  assert.equal(bodyOf(validated.envelope)["state"], "validated");
  const record = parseUnitRecord(await readFile(join(h.root, "can.generated", "u1", "unit.json"), "utf8"), "u1");
  assert.equal(record.provenance.origin, "generated");
  assert.equal(await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8"), "/* tweaked */\n.root{color:red}\n");
});

test("rollback previous restores with compatibility checking", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const first = await dispatchControl(
    req("r-rb0", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(first.code, 0, first.envelope);
  const firstCss = await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8");
  // Refine and accept a second revision.
  const refined = await dispatchControl(
    req("r-rb1", "refine", { root: h.root, unit_id: "u1", instruction: "Change it.", accept: true, ...RECIPE }),
    ctxFor(h, { onSession: submitAll() }),
  );
  assert.equal(refined.code, 0, refined.envelope);
  assert.equal(bodyOf(refined.envelope)["state"], "accepted");
  // Roll back to the retained previous group.
  const rolled = await dispatchControl(
    req("r-rb2", "rollback", { root: h.root, unit_id: "u1", revision: "previous" }),
    ctxFor(h),
  );
  assert.equal(rolled.code, 0, rolled.envelope);
  assert.equal(bodyOf(rolled.envelope)["state"], "rolled-back");
  assert.equal(await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8"), firstCss);
  assert.deepEqual(await unresolvedJournals(h.root), []);
  // Rolling back with no retained group diagnoses.
  await rm(join(h.root, ".can/gen/previous", "u1"), { recursive: true, force: true });
  const missing = await dispatchControl(
    req("r-rb3", "rollback", { root: h.root, unit_id: "u1", revision: "previous" }),
    ctxFor(h),
  );
  assert.equal(missing.code, 2);
  assert.equal((bodyOf(missing.envelope)["error"] as { code: string }).code, "no-previous");
});

test("rollback git restores from source control", async () => {
  const { execFileSync } = await import("node:child_process");
  let gitOk = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    gitOk = false;
  }
  if (!gitOk) {
    // No git binary: the revision still diagnoses honestly.
    const h = await harness();
    h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
    const seed = await dispatchControl(
      req("r-rg0", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
      ctxFor(h),
    );
    assert.equal(seed.code, 0, seed.envelope);
    const rolled = await dispatchControl(
      req("r-rg1", "rollback", { root: h.root, unit_id: "u1", revision: "git:HEAD" }),
      ctxFor(h, {
        git: async () => { throw new Error("spawn git ENOENT"); },
      }),
    );
    assert.equal(rolled.code, 2);
    assert.equal((bodyOf(rolled.envelope)["error"] as { code: string }).code, "git-unavailable");
    return;
  }
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const seed = await dispatchControl(
    req("r-rg0", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(seed.code, 0, seed.envelope);
  const firstCss = await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8");
  execFileSync("git", ["init"], { cwd: h.root, stdio: "ignore" });
  execFileSync("git", ["add", "can.generated", "app.can"], { cwd: h.root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "first"], { cwd: h.root, stdio: "ignore" });
  await writeFile(join(h.root, "can.generated", "u1", "style.css"), "/* newer */\n.x{color:black}\n");
  const rolled = await dispatchControl(
    req("r-rg1", "rollback", { root: h.root, unit_id: "u1", revision: "git:HEAD" }),
    ctxFor(h),
  );
  assert.equal(rolled.code, 0, rolled.envelope);
  assert.equal(bodyOf(rolled.envelope)["state"], "rolled-back");
  assert.equal(await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8"), firstCss);
  const unknown = await dispatchControl(
    req("r-rg2", "rollback", { root: h.root, unit_id: "u1", revision: "git:does-not-exist" }),
    ctxFor(h),
  );
  assert.equal(unknown.code, 2);
  assert.equal((bodyOf(unknown.envelope)["error"] as { code: string }).code, "unknown-revision");
});

test("edit begin and end coordinate exact paths", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const seed = await dispatchControl(
    req("r-eb0", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(seed.code, 0, seed.envelope);
  const begun = await dispatchControl(
    req("r-eb1", "edit.begin", { root: h.root, unit_id: "u1" }),
    ctxFor(h),
  );
  assert.equal(begun.code, 0, begun.envelope);
  const begunBody = bodyOf(begun.envelope);
  assert.equal(begunBody["state"], "editing");
  const token = begunBody["token"] as string;
  assert.match(token, /^v1-[0-9a-f]{16}$/);
  const paths = begunBody["paths"] as string[];
  assert.ok(paths.includes("can.generated/u1/style.css"));
  assert.ok(paths.includes("can.generated/u1/unit.json"));
  assert.ok(paths.includes("app.can"));
  // An overlapping edit conflicts while the first holds its leases.
  const overlap = await dispatchControl(
    req("r-eb2", "edit.begin", { root: h.root, paths: ["can.generated/u1/style.css"] }),
    ctxFor(h),
  );
  assert.equal(overlap.code, 3);
  // Releasing frees the paths for the next writer.
  const ended = await dispatchControl(req("r-eb3", "edit.end", { root: h.root, token }), ctxFor(h));
  assert.equal(ended.code, 0, ended.envelope);
  assert.equal(bodyOf(ended.envelope)["state"], "released");
  const again = await dispatchControl(
    req("r-eb4", "edit.begin", { root: h.root, paths: ["can.generated/u1/style.css"] }),
    ctxFor(h),
  );
  assert.equal(again.code, 0, again.envelope);
  const unknown = await dispatchControl(
    req("r-eb5", "edit.end", { root: h.root, token: "v1-0000000000000000" }),
    ctxFor(h),
  );
  assert.equal(unknown.code, 2);
  assert.equal((bodyOf(unknown.envelope)["error"] as { code: string }).code, "unknown-token");
});

test("lease recover restores staged journals and finishes committed ones", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const seed = await dispatchControl(
    req("r-lr0", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(seed.code, 0, seed.envelope);
  const before = await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8");
  // Simulate a crash between stage and commit.
  await stageJournal(h.root, "run-crash-staged", ["u1"], [
    { unit: "u1", path: "style.css", bytes: new TextEncoder().encode("/* staged */\n") },
  ]);
  const held = await acquire(h.root, ["can.generated/u1/style.css"], "write", "crashed-writer");
  const recovered = await dispatchControl(
    req("r-lr1", "lease.recover", { root: h.root, lease: `${held.holder}@${held.token}` }),
    ctxFor(h),
  );
  assert.equal(recovered.code, 0, recovered.envelope);
  const body = bodyOf(recovered.envelope);
  assert.equal(body["state"], "recovered");
  const runs = body["runs"] as { run: string; outcome: string }[];
  assert.deepEqual(runs, [{ run: "run-crash-staged", outcome: "restored-old" }]);
  assert.equal(await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8"), before);
  // Simulate a crash between commit and apply.
  await stageJournal(h.root, "run-crash-committed", ["u1"], [
    { unit: "u1", path: "style.css", bytes: new TextEncoder().encode("/* committed */\n") },
  ]);
  await markCommitted(h.root, "run-crash-committed");
  const held2 = await acquire(h.root, ["can.generated/u1/style.css"], "write", "crashed-writer-2");
  const recovered2 = await dispatchControl(
    req("r-lr2", "lease.recover", { root: h.root, lease: `${held2.holder}@${held2.token}` }),
    ctxFor(h),
  );
  assert.equal(recovered2.code, 0, recovered2.envelope);
  const runs2 = (bodyOf(recovered2.envelope)["runs"] as { run: string; outcome: string; files: number }[])[0];
  assert.equal(runs2?.outcome, "completed-new");
  assert.equal(await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8"), "/* committed */\n");
  assert.deepEqual(await unresolvedJournals(h.root), []);
  // Nothing to recover diagnoses.
  const nothing = await dispatchControl(
    req("r-lr3", "lease.recover", { root: h.root, lease: "ghost@v1-0000000000000000" }),
    ctxFor(h),
  );
  assert.equal(nothing.code, 2);
  assert.equal((bodyOf(nothing.envelope)["error"] as { code: string }).code, "unknown-lease");
});

test("accept refuses while a journal over its scope is unresolved", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const produced = await dispatchControl(
    req("r-uj1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const attempt = (bodyOf(produced.envelope)["attempts"] as { attempt: string }[])[0]?.attempt as string;
  await stageJournal(h.root, "run-blocker", ["u1"], [
    { unit: "u1", path: "style.css", bytes: new TextEncoder().encode("/* blocker */\n") },
  ]);
  const refused = await dispatchControl(req("r-uj2", "accept", { root: h.root, attempt }), ctxFor(h));
  assert.equal(refused.code, 3);
  assert.equal((bodyOf(refused.envelope)["error"] as { code: string }).code, "unresolved-journal");
});

test("reset discards pending work and frees the request id", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const produced = await dispatchControl(
    req("r-rs1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const attempt = (bodyOf(produced.envelope)["attempts"] as { attempt: string }[])[0]?.attempt as string;
  const reset = await dispatchControl(req("r-rs2", "reset", { root: h.root, attempt }), ctxFor(h));
  assert.equal(reset.code, 0, reset.envelope);
  assert.equal(bodyOf(reset.envelope)["state"], "reset");
  await assert.rejects(readFile(join(h.root, ".can/gen/attempts", attempt, "candidates", "u1-style", "style.css"), "utf8"));
  // Current files survive the reset.
  assert.ok((await readFile(join(h.root, "can.generated", "u1", "unit.json"), "utf8")).includes("u1"));
  // The same generation id starts fresh work instead of recovering.
  const fresh = await dispatchControl(
    req("r-rs1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(fresh.code, 0, fresh.envelope);
  assert.ok((await readFile(join(h.root, ".can/gen/attempts", attempt, "candidates", "u1-style", "style.css"), "utf8")).includes("u1-style"));
});

test("reset unit rescopes a multi-unit attempt to its remainder", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  const produced = await dispatchControl(
    req("r-ru1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const attempt = (bodyOf(produced.envelope)["attempts"] as { attempt: string }[])[0]?.attempt as string;
  const reset = await dispatchControl(req("r-ru2", "reset", { root: h.root, unit_id: "u2" }), ctxFor(h));
  assert.equal(reset.code, 0, reset.envelope);
  assert.match(JSON.stringify(bodyOf(reset.envelope)["attempts"]), /rescoped/);
  const capture = JSON.parse(await readFile(join(h.root, ".can/gen/attempts", attempt, "capture.json"), "utf8")) as CaptureRecord;
  assert.deepEqual(capture.units.map((unit) => unit.unit_id), ["u1"]);
  // The remainder still accepts whole through one journal.
  const accepted = await dispatchControl(req("r-ru3", "accept", { root: h.root, attempt }), ctxFor(h));
  assert.equal(accepted.code, 0, accepted.envelope);
  assert.equal(bodyOf(accepted.envelope)["state"], "accepted");
  assert.ok((await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8")).includes("u1-style"));
  await assert.rejects(readFile(join(h.root, "can.generated", "u2", "style.css"), "utf8"));
});

test("cancel by unknown selector refuses", async () => {
  const h = await harness();
  const result = await dispatchControl(req("r-cu1", "cancel", { root: h.root, request: "nope" }), ctxFor(h));
  assert.equal(result.code, 2);
  assert.equal((bodyOf(result.envelope)["error"] as { code: string }).code, "unknown-session");
});

test("diff reports machine-consumable current-vs-candidate hunks", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const seed = await dispatchControl(
    req("r-df0", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(seed.code, 0, seed.envelope);
  const refined = await dispatchControl(
    req("r-df1", "refine", { root: h.root, unit_id: "u1", instruction: "Change it.", ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(refined.code, 0, refined.envelope);
  const diffed = await dispatchControl(req("r-df2", "diff", { root: h.root, unit_id: "u1" }), ctxFor(h));
  assert.equal(diffed.code, 0, diffed.envelope);
  const body = bodyOf(diffed.envelope);
  assert.equal(body["state"], "reported");
  const files = body["files"] as { path: string; status: string; old_sha256: string; new_sha256: string; hunks: { hunks: unknown[]; truncated: boolean; binary: boolean } }[];
  const css = files.find((entry) => entry.path === "style.css");
  assert.ok(css !== undefined);
  // The refine candidate resubmits identical canned bytes: identical, no hunks.
  assert.equal(css.status, "identical");
  assert.equal(css.old_sha256, css.new_sha256);
  // A targeted attempt selector and an unknown unit behave.
  const attempt = (bodyOf(refined.envelope)["attempts"] as { attempt: string }[])[0]?.attempt as string;
  const scoped = await dispatchControl(req("r-df3", "diff", { root: h.root, unit_id: "u1", attempt }), ctxFor(h));
  assert.equal(scoped.code, 0, scoped.envelope);
  const missing = await dispatchControl(req("r-df4", "diff", { root: h.root, unit_id: "u99" }), ctxFor(h));
  assert.equal(missing.code, 2);
});

test("diff shows added files and unified hunks for modified ones", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const produced = await dispatchControl(
    req("r-da1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const diffed = await dispatchControl(req("r-da2", "diff", { root: h.root, unit_id: "u1" }), ctxFor(h));
  assert.equal(diffed.code, 0, diffed.envelope);
  const files = bodyOf(diffed.envelope)["files"] as { path: string; status: string; hunks: { hunks: { lines: string[] }[] } }[];
  const css = files.find((entry) => entry.path === "style.css");
  assert.ok(css !== undefined);
  assert.equal(css.status, "added");
  assert.ok(css.hunks.hunks.length > 0);
  assert.ok(css.hunks.hunks[0]?.lines.some((line) => line.startsWith("+")));
});

test("preview inlines text candidates and summarizes assets", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const produced = await dispatchControl(
    req("r-pv1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const previewed = await dispatchControl(req("r-pv2", "preview", { root: h.root, unit_id: "u1" }), ctxFor(h));
  assert.equal(previewed.code, 0, previewed.envelope);
  const previews = bodyOf(previewed.envelope)["previews"] as { handle: string; text: string | null; truncated: boolean }[];
  const css = previews.find((entry) => entry.handle === "u1-style");
  assert.ok(css !== undefined);
  assert.ok((css.text ?? "").includes("u1-style"));
  assert.equal(css.truncated, false);
});

test("status overlays produced work and operations without source names", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", twoStyles());
  const produced = await dispatchControl(
    req("r-st1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const status = await dispatchControl(
    req("r-st2", "status", { root: h.root, files: ["app.can"] }),
    ctxFor(h),
  );
  assert.equal(status.code, 0, status.envelope);
  const body = bodyOf(status.envelope);
  assert.equal(body["ok"], true);
  // Compiler fields pass through untouched.
  assert.ok(Array.isArray(body["units"]));
  // Produced work is keyed by unit: no source names needed.
  const producedOverlay = body["produced"] as Record<string, { attempts: { attempt: string; complete: boolean; handles: { handle: string }[] }[] }>;
  assert.deepEqual(Object.keys(producedOverlay).sort(), ["u1", "u2"]);
  assert.equal(producedOverlay["u1"]?.attempts[0]?.complete, true);
  assert.ok((producedOverlay["u1"]?.attempts[0]?.handles ?? []).some((entry) => entry.handle === "u1-style"));
  // Recorded operations list their terminal outcomes.
  const operations = body["operations"] as { request_id: string; operation: string; state: string; exit: number; superseded: boolean }[];
  const entry = operations.find((candidate) => candidate.request_id === "r-st1");
  assert.ok(entry !== undefined);
  assert.equal(entry.operation, "retry");
  assert.equal(entry.state, "candidate");
  assert.equal(entry.exit, 0);
  assert.equal(entry.superseded, false);
});

test("compiler-owned operations pass through verbatim", async () => {
  const h = await harness();
  const inspected = await dispatchControl(
    req("r-pt1", "inspect", { root: h.root, unit_id: "u9" }),
    ctxFor(h),
  );
  assert.equal(inspected.code, 0, inspected.envelope);
  const body = bodyOf(inspected.envelope);
  assert.equal((body["unit"] as { id: string }).id, "u9");
  assert.equal(h.fake.calls.filter((call) => call.operation === "inspect").length, 1);
  // Bind resends return the recorded envelope instead of rebinding.
  const revision = sha256HexText(APP);
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const first = await dispatchControl(
    req("r-pt2", "bind", { root: h.root, file: "app.can", start: 100, end: 160, revision, unit: "new" }),
    ctxFor(h),
  );
  assert.equal(first.code, 0, first.envelope);
  const binds = h.fake.calls.filter((call) => call.operation === "bind").length;
  const second = await dispatchControl(
    req("r-pt2", "bind", { root: h.root, file: "app.can", start: 100, end: 160, revision, unit: "new" }),
    ctxFor(h),
  );
  assert.equal(second.envelope, first.envelope);
  assert.equal(h.fake.calls.filter((call) => call.operation === "bind").length, binds);
});

test("resume continues a recorded session when the capture holds", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const produced = await dispatchControl(
    req("r-rs1", "retry", { root: h.root, files: ["app.can"], ...RECIPE, runner: "claude-code" }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const { readAttempt } = await import("./lifecycle.js");
  const recorded = await readAttempt(join(h.root, ".can/gen/attempts", "r-rs1.j0"));
  const resumed = await dispatchControl(
    req("r-rs2", "resume", { root: h.root, session_id: recorded.session }),
    ctxFor(h),
  );
  assert.equal(resumed.code, 0, resumed.envelope);
  const body = bodyOf(resumed.envelope);
  assert.equal(body["resumed_from"], "r-rs1.j0");
  assert.equal(body["disk_complete"], true);
  assert.equal(body["state"], "candidate");
});

test("resume refuses when the capture changed", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const produced = await dispatchControl(
    req("r-rc1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const { readAttempt } = await import("./lifecycle.js");
  const recorded = await readAttempt(join(h.root, ".can/gen/attempts", "r-rc1.j0"));
  await writeFile(join(h.root, "app.can"), `${APP}## drifted\n`);
  const refused = await dispatchControl(
    req("r-rc2", "resume", { root: h.root, session_id: recorded.session }),
    ctxFor(h),
  );
  assert.equal(refused.code, 3);
  assert.equal((bodyOf(refused.envelope)["error"] as { code: string }).code, "capture-changed");
  const unknown = await dispatchControl(
    req("r-rc3", "resume", { root: h.root, session_id: "no-such-session" }),
    ctxFor(h),
  );
  assert.equal(unknown.code, 2);
  assert.equal((bodyOf(unknown.envelope)["error"] as { code: string }).code, "unknown-session");
});

test("scanAttempts and control records expose real state", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  assert.deepEqual(await scanAttempts(h.root), []);
  assert.deepEqual(await listControlRecords(h.root), []);
  const produced = await dispatchControl(
    req("r-sa1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctxFor(h),
  );
  assert.equal(produced.code, 0, produced.envelope);
  const attempts = await scanAttempts(h.root);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.capture?.units.length, 1);
  assert.equal(attempts[0]?.record?.request_id, "r-sa1.job0");
  const records = await listControlRecords(h.root);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.request_id, "r-sa1");
  assert.equal(attemptFor("r-x", 3), "r-x.j3");
  assert.equal(attemptFor("../../evil", 0), `id-${hashInput("../../evil").slice(0, 16)}.j0`);
  assert.equal(runFor("run", "r-x"), "run-r-x");
});

test("textHunks diffs, truncates, and flags binary pairs", async () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  const identical = textHunks(text("a\nb\n"), text("a\nb\n"));
  assert.equal(identical.binary, false);
  assert.equal(identical.hunks.length, 0);
  const modified = textHunks(text("a\nb\nc\n"), text("a\nB\nc\nd\n"));
  assert.equal(modified.binary, false);
  assert.ok(modified.hunks.length > 0);
  const lines = (modified.hunks[0] as { lines: string[] }).lines.join("\n");
  assert.match(lines, /-b/);
  assert.match(lines, /\+B/);
  assert.match(lines, /\+d/);
  const binary = textHunks(text("a\n"), new Uint8Array([0xff, 0xfe, 0x00]));
  assert.equal(binary.binary, true);
  assert.equal(binary.hunks.length, 0);
  const big = Array.from({ length: 2000 }, (_, i) => `line-${String(i)}`).join("\n");
  const changed = Array.from({ length: 2000 }, (_, i) => `LINE-${String(i)}`).join("\n");
  const truncated = textHunks(text(big), text(changed));
  assert.equal(truncated.truncated, true);
});

test("real compiler bridge serves the status seam when built", async () => {
  const { existsSync } = await import("node:fs");
  const { defaultCompilerPath } = await import("./controls.js");
  const binary = process.env["CAN_COMPILER_BIN"] ?? defaultCompilerPath();
  if (!existsSync(binary)) {
    console.log("# skip: compiler binary not built; run cargo build first");
    return;
  }
  const root = await freshRoot();
  await writeTree(root, [["app.can", APP]]);
  const result = await dispatchControl(
    req("r-real1", "status", { root, files: ["app.can"] }),
    { now: nowStub },
  );
  assert.equal(result.code, 0, result.envelope);
  const body = bodyOf(result.envelope);
  assert.equal(body["ok"], true);
  const units = body["units"] as { prompt: string | null; contract: unknown; span: unknown }[];
  assert.ok(units.length >= 2);
  for (const unit of units) {
    assert.ok(typeof unit.prompt === "string" && unit.prompt.length > 0);
    assert.ok(unit.contract !== null && typeof unit.contract === "object");
    assert.ok(unit.span !== null && typeof unit.span === "object");
  }
  assert.deepEqual(body["produced"], {});
});

test("full retry records its parent set and accepts only complete", async () => {
  const h = await harness();
  await writeTree(h.root, [
    [
      "can.gen.toml",
      'version=1\n[generation]\nrunner="codex"\nmodel="base"\n[generation.profiles.first]\nrunner="codex"\nmodel="a"\n[generation.profiles.second]\nrunner="codex"\nmodel="b"\n',
    ],
  ]);
  h.fake.descriptors.set("app.can", [
    { ...styleDescriptor("First", "First look", 100, 160), profile: "first" },
    { ...styleDescriptor("Second", "Second look", 200, 260), profile: "second" },
  ]);
  // Seed both current groups so preservation is observable (no run
  // overrides: the two profiles plan two jobs).
  const seed = await dispatchControl(
    req("r-fs0", "retry", { root: h.root, files: ["app.can"], accept: true }),
    ctxFor(h),
  );
  assert.equal(seed.code, 0, seed.envelope);
  assert.equal(bodyOf(seed.envelope)["state"], "accepted");
  const oldU1 = await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8");
  const oldU2 = await readFile(join(h.root, "can.generated", "u2", "style.css"), "utf8");
  // A gate failure still records every job capture before any launch.
  const gated = await dispatchControl(
    req("r-fs1", "retry", { root: h.root, files: ["app.can"] }),
    ctxFor(h, {
      preflight: () => {
        throw new PreflightError("unsupported-capability", "gated");
      },
    }),
  );
  assert.equal(gated.code, 2);
  assert.equal((bodyOf(gated.envelope)["error"] as { code: string }).code, "unsupported-capability");
  for (const order of [0, 1]) {
    const capture = JSON.parse(
      await readFile(join(h.root, ".can/gen/attempts", `r-fs1.j${String(order)}`, "capture.json"), "utf8"),
    ) as CaptureRecord;
    assert.deepEqual(capture.parent_set?.attempts, ["r-fs1.j0", "r-fs1.j1"]);
    assert.deepEqual(capture.parent_set?.units, ["u1", "u2"]);
  }
  // Host-submit one sibling's required set, mirroring a partial retry.
  const hostSubmit = async (attempt: string): Promise<void> => {
    const dir = join(h.root, ".can/gen/attempts", attempt);
    const cap = JSON.parse(await readFile(join(dir, "capture.json"), "utf8")) as CaptureRecord;
    const kinds = new Map(cap.units.map((entry) => [entry.unit_id, entry.kind]));
    const allowed = Object.entries(cap.handles).map(([handle, entry]) => ({
      handle,
      role: entry.role as McpRole,
      kind: kinds.get(entry.unit) as string,
      filename: entry.filename,
    }));
    const session = await createMcpSession({
      session: `host-${attempt}`,
      attempt,
      source_digest: cap.source_digest,
      allowed,
      candidateRoot: join(dir, "candidates"),
      required: Object.entries(cap.handles)
        .filter(([, entry]) => entry.required)
        .map(([handle]) => handle),
    });
    const batch = Object.entries(cap.handles)
      .filter(([, entry]) => entry.required)
      .map(([handle, entry]) => ({
        target: handle,
        role: entry.role,
        content_text: `/* host ${attempt} ${handle} */\n.tile{color:teal}\n`,
      }));
    await session.submit(`host-${attempt}`, batch);
  };
  await hostSubmit("r-fs1.j0");
  // A sibling accept resolves the parent set and refuses the partial
  // set; both current groups are preserved.
  const partial = await dispatchControl(
    req("r-fs2", "accept", { root: h.root, attempt: "r-fs1.j0" }),
    ctxFor(h),
  );
  assert.equal(partial.code, 4);
  assert.equal((bodyOf(partial.envelope)["error"] as { code: string }).code, "incomplete-set");
  assert.equal(await readFile(join(h.root, "can.generated", "u1", "style.css"), "utf8"), oldU1);
  assert.equal(await readFile(join(h.root, "can.generated", "u2", "style.css"), "utf8"), oldU2);
  // Unit scope likewise refuses a member of a multi-attempt set.
  const unitAccept = await dispatchControl(
    req("r-fs4", "accept", { root: h.root, unit_id: "u1" }),
    ctxFor(h),
  );
  assert.equal(unitAccept.code, 2);
  assert.equal((bodyOf(unitAccept.envelope)["error"] as { code: string }).code, "full-set-required");
  // Complete the set: the same sibling accept promotes both through
  // one coordinated journal.
  await hostSubmit("r-fs1.j1");
  const full = await dispatchControl(
    req("r-fs3", "accept", { root: h.root, attempt: "r-fs1.j0" }),
    ctxFor(h),
  );
  assert.equal(full.code, 0, full.envelope);
  assert.equal(bodyOf(full.envelope)["state"], "accepted");
  assert.deepEqual((bodyOf(full.envelope)["units"] as string[]).sort(), ["u1", "u2"]);
  assert.deepEqual(bodyOf(full.envelope)["attempts"], ["r-fs1.j0", "r-fs1.j1"]);
  const run = bodyOf(full.envelope)["run"] as string;
  const resolved = JSON.parse(
    await readFile(join(h.root, ".can/gen/runs", run, "journal.resolved.json"), "utf8"),
  ) as { scope: string[] };
  assert.deepEqual([...resolved.scope].sort(), ["u1", "u2"]);
  for (const id of ["u1", "u2"]) {
    const current = await readFile(join(h.root, "can.generated", id, "style.css"), "utf8");
    assert.ok(current.includes("host r-fs1"), current);
  }
});

test("prepare regenerates an identity whose candidate was never accepted", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const first = await dispatchControl(req("r-unborn1", "generate", {
    root: h.root, files: ["app.can"], mode: "fresh", ...RECIPE,
  }), ctxFor(h));
  assert.equal(first.code, 0, first.envelope);
  const prepared = await dispatchControl(req("r-unborn2", "generate", {
    root: h.root, files: ["app.can"], mode: "prepare", ...RECIPE,
  }), ctxFor(h));
  assert.equal(prepared.code, 0, prepared.envelope);
  const attempts = bodyOf(prepared.envelope)["attempts"] as { units: string[] }[];
  assert.deepEqual(attempts.map(attempt => attempt.units), [["u1"]]);
  await assert.rejects(readFile(join(h.root, "can.generated/u1/style.css")));
});

test("mixed retry stages Given before frontend and checks app acceptance only after the complete set", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [
    {
      owner: "Tasks",
      kind: "named-trait",
      label: "completable",
      anchor: "trait completable",
      prompt: "Add done:bool=false.",
      profile: null,
      target: null,
      signature: null,
      span: { start: 10, end: 60 },
    },
    styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160),
    styleDescriptor("EntryArea", "A compact entry area.", 200, 260),
  ]);
  // A waiting fake that also dumps the agent prompt it received.
  const dumper = await writeFake(
    h.root,
    "dump-runner",
    `
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", async () => {
  let want = Number(process.env.SUBMIT_WAIT_N ?? Number.NaN);
  if (!Number.isInteger(want) || want < 0) {
    try {
      want = JSON.parse(fs.readFileSync("session.json", "utf8")).allowed;
    } catch { want = 1; }
  }
  for (let i = 0; i < 400; i += 1) {
    let found = 0;
    try {
      for (const entry of fs.readdirSync("candidates")) {
        try { fs.statSync("candidates/" + entry + "/submission.json"); found += 1; } catch {}
      }
    } catch {}
    if (found >= want) {
      fs.writeFileSync("prompt.txt", stdin);
      console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-1" }));
      console.log(JSON.stringify({ status: "ok" }));
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  process.exit(1);
});
`,
  );
  let appChecks = 0;
  const result = await dispatchControl(
    req("r-mx1", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }),
    ctxFor(h, { resolveExecutable: async () => dumper, appAcceptance: async input => {
      appChecks += 1;
      assert.match(await readFile(join(input.candidateRoot, "can.generated/u1/contributions.can"), "utf8"), /u1-contributions/);
      for (const unit of ["u2", "u3"]) {
        assert.match(await readFile(join(input.candidateRoot, "can.generated", unit, "style.css"), "utf8"), new RegExp(`${unit}-style`));
      }
      assert.equal(existsSync(join(h.root, "can.generated/u1/contributions.can")), false);
    } }),
  );
  assert.equal(appChecks, 1, "Given preparation must not run the complete app gate before frontend candidates exist");
  assert.equal(result.code, 0, result.envelope);
  assert.equal(bodyOf(result.envelope)["state"], "accepted");
  const attempts = bodyOf(result.envelope)["attempts"] as { attempt: string; units: string[] }[];
  assert.equal(attempts.length, 2);
  const given = attempts.find((entry) => entry.attempt === "r-mx1.j0")!;
  const frontend = attempts.find((entry) => entry.attempt === "r-mx1.j1")!;
  assert.deepEqual(given.units, ["u1"]);
  assert.deepEqual([...frontend.units].sort(), ["u2", "u3"]);
  assert.deepEqual((bodyOf(result.envelope)["accepted"] as { units: string[] }).units.sort(), ["u1", "u2", "u3"]);
  const givenPrompt = await readFile(join(h.root, ".can/gen/attempts", "r-mx1.j0", "prompt.txt"), "utf8");
  assert.ok(givenPrompt.includes("Add done:bool=false."), givenPrompt);
  assert.ok(givenPrompt.includes(APP), "the complete frozen source supplies structural context");
  assert.ok(givenPrompt.includes('"role":"contributions","required":true'), givenPrompt);
  const frontendPrompt = await readFile(join(h.root, ".can/gen/attempts", "r-mx1.j1", "prompt.txt"), "utf8");
  assert.ok(frontendPrompt.includes("Readable task surfaces."), frontendPrompt);
  assert.ok(frontendPrompt.includes("A compact entry area."), frontendPrompt);
  assert.ok(frontendPrompt.includes(APP), "frontend generation also receives the complete source");
  const capture = JSON.parse(await readFile(join(h.root, ".can/gen/attempts", "r-mx1.j1", "capture.json"), "utf8")) as CaptureRecord;
  assert.equal(capture.instructions, frontendPrompt);
  assert.ok(frontendPrompt.includes("Checked Given preparation"), frontendPrompt);
  assert.ok(frontendPrompt.includes("bare universal * selectors"), frontendPrompt);
  assert.ok(frontendPrompt.includes("row.fields.done"), frontendPrompt);
  assert.ok(frontendPrompt.includes("contributions"), frontendPrompt);
});

test("invalid Given candidates prevent dependent frontend launch", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [{ owner: "Tasks", kind: "named-trait", label: "completable", anchor: "trait completable", prompt: "Add done:bool=false.", profile: null, target: null, signature: null, span: { start: 10, end: 60 } }, styleDescriptor("TaskSurface", "Readable.", 100, 160)]);
  h.fake.failValidateUnits.set("u1", "invalid trait schema");
  let launched = 0;
  const submit = submitAll();
  const result = await dispatchControl(req("r-given-invalid", "retry", { root: h.root, files: ["app.can"], ...RECIPE }), ctxFor(h, { onSession: async (session) => { launched += 1; await submit(session); } }));
  assert.equal(result.code, 4, result.envelope);
  assert.equal(launched, 1, "frontend must not launch after failed Given validation");
  const frontend = JSON.parse(await readFile(join(h.root, ".can/gen/attempts/r-given-invalid.j1/capture.json"), "utf8")) as CaptureRecord;
  assert.ok(frontend.parent_set);
  assert.equal(existsSync(join(h.root, ".can/gen/attempts/r-given-invalid.j1/session.json")), false);
  assert.equal(existsSync(join(h.root, "can.generated/u1/contributions.can")), false, "candidate preparation must not promote");
});

test("retry serves submissions over the production MCP bridge", async () => {
  const h = await harness();
  h.fake.descriptors.set("app.can", [styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160)]);
  const bridgeScript = fileURLToPath(import.meta.resolve("./mcp.js"));
  // A fake runner speaking MCP stdio to the real attached bridge: no
  // session hook, no paid generation, host-owned placement only.
  const mcpFake = await writeFake(
    h.root,
    "mcp-runner",
    `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const BRIDGE = ${JSON.stringify(bridgeScript)};
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", async () => {
  const out = { argv: process.argv.slice(2), hadProfile: process.argv.includes("-p"), steps: [] };
  try {
    const binding = process.env.CAN_GENERATION_SESSION_FILE;
    if (!binding) throw new Error("no session binding env");
    const bridge = spawn(process.execPath, [BRIDGE, "--bridge"], {
      env: { ...process.env, CAN_GENERATION_SESSION_FILE: binding },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let stderr = "";
    bridge.stderr.setEncoding("utf8");
    bridge.stderr.on("data", (c) => { stderr += c; });
    bridge.stdout.setEncoding("utf8");
    const waiters = [];
    bridge.stdout.on("data", (c) => {
      buf += c;
      let idx = buf.indexOf("\\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim().length > 0) {
          const waiter = waiters.shift();
          if (waiter) waiter(JSON.parse(line));
        }
        idx = buf.indexOf("\\n");
      }
    });
    let nextId = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      waiters.push((msg) => {
        if (msg.id === id) resolve(msg);
        else reject(new Error("out-of-order bridge response"));
      });
      bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
    });
    const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "0" } });
    if (!init.result || !init.result.serverInfo) throw new Error("bad initialize: " + JSON.stringify(init));
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
    const listed = await call("tools/list", {});
    const names = ((listed.result && listed.result.tools) || []).map((t) => t.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(["generation_context", "generation_submit"])) {
      throw new Error("bad tools: " + names.join(","));
    }
    const contextCall = await call("tools/call", { name: "generation_context", arguments: {} });
    const context = JSON.parse(contextCall.result.content[0].text);
    const batch = context.allowed.map((target) => target.role === "asset"
      ? { target: target.handle, role: target.role, content_base64: Buffer.from("asset:" + target.handle).toString("base64") }
      : { target: target.handle, role: target.role, content_text: "/* bridge:" + target.handle + " */\\n.root{color:blue}\\n" });
    const submitted = await call("tools/call", { name: "generation_submit", arguments: { session: context.session, batch } });
    const report = JSON.parse(submitted.result.content[0].text);
    if (report.complete !== true) throw new Error("bridge reports incomplete: " + JSON.stringify(report));
    out.steps = ["initialize", "list", "context", "submit"];
    bridge.stdin.end();
    const code = await new Promise((resolve) => bridge.on("close", resolve));
    if (code !== 0) throw new Error("bridge exited " + String(code) + ": " + stderr.slice(0, 500));
    fs.writeFileSync("bridge-argv.json", JSON.stringify(out));
    console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread-bridge" }));
    console.log(JSON.stringify({ status: "ok" }));
    process.exit(0);
  } catch (error) {
    fs.writeFileSync("bridge-argv.json", JSON.stringify({ ...out, error: String((error && error.message) || error) }));
    process.stderr.write("mcp fake failed: " + String((error && error.message) || error) + "\\n");
    process.exit(1);
  }
});
`,
  );
  // Production path: default bridge, isolated Codex home, no hook.
  const ctx: ControlContext = {
    compiler: h.fake.compiler,
    now: nowStub,
    preflight: noopPreflight,
    resolveExecutable: async () => mcpFake,
    codexHome: join(h.root, "codex-home"),
  };
  const result = await dispatchControl(
    req("r-br1", "retry", { root: h.root, files: ["app.can"], ...RECIPE }),
    ctx,
  );
  assert.equal(result.code, 0, result.envelope);
  const body = bodyOf(result.envelope);
  assert.equal(body["state"], "candidate");
  assert.equal(body["complete"], true);
  const attempts = body["attempts"] as { attempt: string }[];
  assert.equal(attempts.length, 1);
  const attemptDir = join(h.root, ".can/gen/attempts", attempts[0]?.attempt as string);
  const argv = JSON.parse(await readFile(join(attemptDir, "bridge-argv.json"), "utf8")) as {
    hadProfile: boolean;
    steps: string[];
    error?: string;
  };
  assert.equal(argv.error, undefined);
  assert.equal(argv.hadProfile, true);
  assert.deepEqual(argv.steps, ["initialize", "list", "context", "submit"]);
  // The host placed the bridge-submitted bytes; the profile layer is gone.
  const css = await readFile(join(attemptDir, "candidates", "u1-style", "style.css"), "utf8");
  assert.ok(css.includes("bridge:u1-style"), css);
  const leftovers = readdirSync(join(attemptDir, "codex-home")).filter((name) => name.endsWith(".config.toml"));
  assert.deepEqual(leftovers, []);
});





async function retainedGivenFixture(): Promise<Harness> {
  const h = await harness();
  h.fake.descriptors.set("app.can", [
    { owner: "Tasks", kind: "named-trait", label: "completable", anchor: "trait completable", prompt: "Add done:bool=false.", profile: null, target: null, signature: null, span: { start: 10, end: 60 } },
    styleDescriptor("TaskSurface", "Readable task surfaces.", 100, 160),
  ]);
  const seeded = await dispatchControl(req("retained-seed", "retry", { root: h.root, files: ["app.can"], accept: true, ...RECIPE }), ctxFor(h));
  assert.equal(seeded.code, 0, seeded.envelope);
  await writeFile(join(h.root, "can.generated/u1/contributions.can"), "app Tasks\nGiven\n completable {done:bool=true}\n");
  return h;
}

test("frontend prepare consumes saved edited Given context without generating it", async () => {
  const h = await retainedGivenFixture();
  h.fake.descriptors.get("app.can")![1]!.prompt = "Darker task surfaces.";
  let launches = 0;
  let instructions = "";
  let checkedDependency = false;
  const prepared = await dispatchControl(req("retained-prepare", "generate", { root: h.root, files: ["app.can"], mode: "prepare", accept: true, ...RECIPE }), ctxFor(h, {
    resolveExecutable: async () => { launches++; return h.runner; },
    onSession: session => { instructions = session.context().instructions ?? ""; submitAll()(session); },
    compiler: async json => {
      const request = JSON.parse(json) as Record<string, unknown>;
      if (request.operation === "validate" && request.unit_id === "u2") {
        const scratch = request.root as string;
        const context = parseUnitRecord(await readFile(join(scratch, "can.generated/u1/unit.json"), "utf8"), "u1");
        assert.equal(context.source.path, "app.can", "all copied dependency records resolve frozen scratch sources");
        assert.equal(await readFile(join(scratch, "can.generated/u1/contributions.can"), "utf8"), "app Tasks\nGiven\n completable {done:bool=true}\n");
        checkedDependency = true;
      }
      return h.fake.compiler(json);
    },
  }));
  assert.equal(prepared.code, 0, prepared.envelope);
  assert.equal(launches, 1);
  assert.equal(checkedDependency, true);
  assert.ok(instructions.includes("Checked Given preparation"), instructions);
  assert.ok(instructions.includes("done:bool=true"), instructions);
  const attempts = bodyOf(prepared.envelope).attempts as { units: string[] }[];
  assert.deepEqual(attempts.map(attempt => attempt.units), [["u2"]]);
  assert.equal(await readFile(join(h.root, "can.generated/u1/contributions.can"), "utf8"), "app Tasks\nGiven\n completable {done:bool=true}\n");
});

test("scoped frontend refine freezes Given dependencies and refuses their later edits", async () => {
  const h = await retainedGivenFixture();
  const oldStyle = await readFile(join(h.root, "can.generated/u2/style.css"), "utf8");
  let instructions = "";
  let launches = 0;
  const generated = await dispatchControl(req("retained-refine", "refine", { root: h.root, unit_id: "u2", instruction: "Make focus clearer.", ...RECIPE }), ctxFor(h, {
    resolveExecutable: async () => { launches++; return h.runner; },
    onSession: session => { instructions = session.context().instructions ?? ""; submitAll()(session); },
  }));
  assert.equal(generated.code, 0, generated.envelope);
  assert.equal(launches, 1);
  assert.ok(instructions.includes("done:bool=true"), instructions);
  const attempts = bodyOf(generated.envelope).attempts as { attempt: string; units: string[] }[];
  assert.deepEqual(attempts.map(attempt => attempt.units), [["u2"]]);
  await writeFile(join(h.root, "can.generated/u1/contributions.can"), "app Tasks\nGiven\n completable {done:bool=false}\n");
  const accepted = await dispatchControl(req("retained-conflict", "accept", { root: h.root, attempt: attempts[0]!.attempt }), ctxFor(h));
  assert.equal(accepted.code, 3, accepted.envelope);
  assert.equal((bodyOf(accepted.envelope).error as { code: string }).code, "context-changed");
  assert.equal(await readFile(join(h.root, "can.generated/u2/style.css"), "utf8"), oldStyle);
  assert.equal(await readFile(join(h.root, "can.generated/u1/contributions.can"), "utf8"), "app Tasks\nGiven\n completable {done:bool=false}\n");
});
