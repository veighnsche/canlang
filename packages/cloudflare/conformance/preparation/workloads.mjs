/**
 * Preparation workloads (P02.3): complete-job CLI workload definitions and
 * runner shared by current/prepared/native differential runs.
 *
 * Each workload gets a FRESH temp dir; effectful modes (--yes) run at most
 * once per dir and the suite never runs a matching confirmed deploy (that
 * would spawn the real wrangler apply — mismatch-refusal only). Outputs
 * are scrubbed (temp dir -> <TMP>) so runs compare byte-identically
 * across checkouts. Durations are recorded but excluded from comparison.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA = "b".repeat(64);

export function validArtifact() {
  return {
    artifact_version: 1,
    language_version: "1.0.0",
    tool_version: "0.1.0",
    sources: [{ path: "app.can", sha256: SHA }],
    modules: [
      {
        path: "worker.mjs",
        js: 'export default { async fetch() { return new Response("ok"); } };\n',
        map: { version: 3, file: "worker.mjs", sources: [], sourcesContent: [], names: [], mappings: "" },
      },
    ],
    callables: [],
    pages: [],
    requires: [],
    tests: [],
  };
}

export function deployBundleFiles() {
  return {
    "teamtasks.artifact.json": JSON.stringify(validArtifact()),
    "teamtasks.descriptor.json": JSON.stringify({
      identity: {
        appName: "TeamTasks",
        sourceRevision: "14fa6a0",
        languageVersion: "1.0.0",
        compilerVersion: "0.1.0",
        contractsVersion: 1,
        artifactDigest: "digest-fixture",
      },
      requiredCapabilities: [],
      resourceBindings: [{ binding: "DB", kind: "d1", logicalName: "teamtasks-db" }],
      secrets: [],
      schedules: [],
    }),
    "teamtasks.prod.environment.json": JSON.stringify({
      environment: "prod",
      resources: [
        {
          requirement: { binding: "DB", kind: "d1", logicalName: "teamtasks-db" },
          resourceId: "db-123",
        },
      ],
      secretsPresent: [],
      vars: { API_URL: "https://api.example.com" },
    }),
    "teamtasks.target.json": JSON.stringify({
      contractsVersion: 1,
      runtimeVersion: "0.1.0",
      knownLanguageVersions: ["1.0.0"],
      capabilities: [],
      supportsSchedules: false,
    }),
  };
}

function writeBundle(dir, mutate) {
  const files = deployBundleFiles();
  if (mutate) mutate(files);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  return join(dir, "teamtasks.artifact.json");
}

function runCli(cliPath, args, timeout = 30000) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [cliPath, ...args], { timeout }, (error, stdout, stderr) => {
      const code =
        error !== null && "code" in error && typeof error.code === "number" ? error.code : 0;
      resolve({ code, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

const scrub = (text, dir) => text.split(dir).join("<TMP>");

function fixtureSha(dir) {
  const files = deployBundleFiles();
  return createHash("sha256").update(Object.values(files).join("\n")).digest("hex");
}

/**
 * Workload: { id, runs: [{ args(artifact), expectCode, expectEnvelope,
 * expectWrites: [relpath...] | "none", mutate? }] }. Mutations apply at
 * setup; each workload runs in one fresh dir, runs in order.
 */
export const WORKLOADS = [
  {
    id: "build-ok",
    runs: [
      {
        args: (a) => ["build", "--artifact", a],
        expectCode: 0,
        expectEnvelope: { ok: true, command: "build" },
        expectWrites: "none",
      },
    ],
  },
  {
    id: "deploy-bare",
    runs: [
      {
        args: (a) => ["deploy", "--artifact", a, "--env", "prod"],
        expectCode: 2,
        expectEnvelope: { ok: false, command: "deploy", code: "confirm-required" },
        expectWrites: "none",
      },
    ],
  },
  {
    id: "deploy-preview",
    runs: [
      {
        args: (a) => ["deploy", "--artifact", a, "--env", "prod", "--preview"],
        expectCode: 0,
        expectEnvelope: { ok: true, command: "deploy", preview: true, wrote: false },
        expectWrites: "none",
        forbidFiles: ["teamtasks.deploy-plan.json", "teamtasks.wrangler.toml"],
      },
    ],
  },
  {
    id: "deploy-preview-yes-identical",
    runs: [
      {
        args: (a) => ["deploy", "--artifact", a, "--env", "prod", "--preview"],
        expectCode: 0,
        expectEnvelope: { ok: true, preview: true, wrote: false },
        expectWrites: "none",
      },
      {
        args: (a) => ["deploy", "--artifact", a, "--env", "prod", "--preview", "--yes"],
        expectCode: 0,
        identicalStdoutToRun: 0,
        expectWrites: "none",
      },
    ],
  },
  {
    id: "deploy-incompatible",
    mutate: (files) => {
      const d = JSON.parse(files["teamtasks.descriptor.json"]);
      d.identity.contractsVersion = 999;
      files["teamtasks.descriptor.json"] = JSON.stringify(d);
    },
    runs: [
      {
        args: (a) => ["deploy", "--artifact", a, "--env", "prod", "--preview"],
        expectCode: 2,
        expectEnvelope: { ok: false, command: "deploy", code: "incompatible" },
        expectWrites: "none",
      },
    ],
  },
  {
    id: "deploy-missing-env",
    runs: [
      {
        args: (a) => ["deploy", "--artifact", a],
        expectCode: 2,
        expectEnvelope: { ok: false, code: "usage" },
        expectWrites: "none",
      },
    ],
  },
  {
    id: "deploy-invalid-artifact",
    mutate: (files) => {
      files["teamtasks.artifact.json"] = "{not json";
    },
    runs: [
      {
        args: (a) => ["deploy", "--artifact", a, "--env", "prod", "--preview"],
        expectCode: 2,
        expectEnvelope: { ok: false, command: "deploy", code: "missing-producer" },
        expectWrites: "none",
      },
    ],
  },
  {
    id: "build-invalid-artifact",
    mutate: (files) => {
      files["teamtasks.artifact.json"] = "{not json";
    },
    runs: [
      {
        args: (a) => ["build", "--artifact", a],
        expectCode: 2,
        expectEnvelope: { ok: false, command: "build", code: "missing-producer" },
        expectWrites: "none",
      },
    ],
  },
  {
    id: "deploy-confirmed-mismatch-refuses",
    mutate: (files) => {
      const d = JSON.parse(files["teamtasks.descriptor.json"]);
      d.identity.compilerVersion = "9.9.9";
      files["teamtasks.descriptor.json"] = JSON.stringify(d);
    },
    runs: [
      {
        args: (a) => ["deploy", "--artifact", a, "--env", "prod", "--yes"],
        expectCode: 2,
        expectEnvelope: { ok: false, command: "deploy", code: "compiler-mismatch" },
        expectWrites: "none",
        forbidFiles: ["teamtasks.deploy-plan.json", "teamtasks.wrangler.toml"],
      },
    ],
  },
];

function envelopeOf(stdout) {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length !== 1) return { _envelopeError: `expected 1 stdout line, got ${lines.length}` };
  try {
    return JSON.parse(lines[0]);
  } catch {
    return { _envelopeError: "stdout is not JSON" };
  }
}

function subsetMatch(envelope, expected) {
  return Object.entries(expected).every(([k, v]) => envelope[k] === v);
}

export async function runWorkload(cliPath, workload) {
  const dir = mkdtempSync(join(tmpdir(), "can-prep-diff-"));
  const artifact = writeBundle(dir, workload.mutate);
  const runs = [];
  let ok = true;
  const notes = [];
  for (let i = 0; i < workload.runs.length; i++) {
    const spec = workload.runs[i];
    const before = new Set(
      ["teamtasks.deploy-plan.json", "teamtasks.wrangler.toml"].filter((f) => existsSync(join(dir, f))),
    );
    const result = await runCli(cliPath, spec.args(artifact));
    const record = {
      args: spec.args("<ARTIFACT>"),
      exit: result.code,
      durationMs: result.durationMs,
      stdout: scrub(result.stdout, dir),
      stderr: scrub(result.stderr, dir),
      stdoutBytes: result.stdout.length,
      stderrBytes: result.stderr.length,
    };
    const env = envelopeOf(result.stdout);
    record.envelope = env;
    if (result.code !== spec.expectCode) {
      ok = false;
      notes.push(`run ${i}: exit ${result.code} != ${spec.expectCode}`);
    }
    if (spec.expectEnvelope && !subsetMatch(env, spec.expectEnvelope)) {
      ok = false;
      notes.push(`run ${i}: envelope mismatch (want subset ${JSON.stringify(spec.expectEnvelope)})`);
    }
    if (spec.identicalStdoutToRun !== undefined) {
      const other = runs[spec.identicalStdoutToRun].stdout;
      record.identicalStdoutToRun = spec.identicalStdoutToRun;
      record.stdoutIdentical = other === record.stdout;
      if (!record.stdoutIdentical) {
        ok = false;
        notes.push(`run ${i}: stdout differs from run ${spec.identicalStdoutToRun}`);
      }
    }
    for (const f of spec.forbidFiles ?? []) {
      if (existsSync(join(dir, f))) {
        ok = false;
        notes.push(`run ${i}: forbidden file written: ${f}`);
      }
    }
    if (spec.expectWrites === "none") {
      const after = ["teamtasks.deploy-plan.json", "teamtasks.wrangler.toml"].filter((f) =>
        existsSync(join(dir, f)),
      );
      const added = after.filter((f) => !before.has(f));
      if (added.length > 0) {
        ok = false;
        notes.push(`run ${i}: unexpected writes: ${added.join(",")}`);
      }
    }
    runs.push(record);
  }
  return { id: workload.id, ok, notes, fixtureSha: fixtureSha(dir), runs };
}

export async function runAll(cliPath, backend) {
  const workloads = [];
  for (const w of WORKLOADS) {
    workloads.push(await runWorkload(cliPath, w));
  }
  return {
    backend,
    runAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    cli: cliPath,
    workloads,
    allOk: workloads.every((w) => w.ok),
  };
}
