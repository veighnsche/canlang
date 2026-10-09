import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CompileArtifact } from "@canlang/contracts";
import { parseArtifactText } from "../runtime/artifact.js";
import {
  captureIsCurrent,
  verifyCompilerSources,
  type CapturedFileIdentity,
  type CompilerSourceReport,
  type SingleFileCapture,
} from "./source-capture.js";

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 8192;
const COMPILER_TIMEOUT_MS = 30_000;

export type CapturedCompileResult =
  | { readonly kind: "artifact"; readonly artifact: CompileArtifact; readonly artifactBytes: Uint8Array; readonly capture: SingleFileCapture }
  | { readonly kind: "diagnostics"; readonly envelope: CompilerSourceReport & { readonly diagnostics: readonly unknown[] }; readonly capture: SingleFileCapture }
  | { readonly kind: "profile_unsupported"; readonly reason: string; readonly capture: SingleFileCapture }
  | { readonly kind: "capture_incomplete"; readonly reason: string; readonly capture: SingleFileCapture }
  | { readonly kind: "tool_failure"; readonly reason: string; readonly capture: SingleFileCapture };

/** The first profile has one implicit app and no package/composition imports. */
export function admitSingleAppProfile(sourceText: string): { ok: true } | { ok: false; reason: string } {
  let apps = 0;
  for (const [index, line] of sourceText.split(/\r?\n/).entries()) {
    const source = line.trimStart();
    if (source === "" || source.startsWith("#")) continue;
    if (/^(?:export\s+)?use\b/.test(source)) {
      return { ok: false, reason: `line ${index + 1}: imported members are outside the first profile` };
    }
    if (/^package\b/.test(source)) {
      return { ok: false, reason: `line ${index + 1}: explicit packages are outside the first profile` };
    }
    if (/^app\b/.test(source)) {
      apps += 1;
      if (/\buses\s*=/.test(source)) {
        return { ok: false, reason: `line ${index + 1}: composed apps are outside the first profile` };
      }
    }
  }
  return apps === 1
    ? { ok: true }
    : { ok: false, reason: `first profile requires exactly one app declaration (found ${apps})` };
}

function input(capture: SingleFileCapture, name: string): CapturedFileIdentity {
  const found = capture.inputs.find(entry => entry.name === name);
  if (found === undefined || found.state !== "present" || found.requestedPath === null || found.sha256 === null) {
    throw new Error(`captured compiler input ${name} is unavailable`);
  }
  return found;
}

async function verifiedBytes(entry: CapturedFileIdentity): Promise<Buffer> {
  if (entry.requestedPath === null || entry.sha256 === null) throw new Error(`missing input ${entry.name}`);
  const bytes = await readFile(entry.requestedPath);
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error(`input ${entry.name} changed after capture`);
  }
  return bytes;
}

function runStagedCompiler(executable: string, catalog: string, capture: SingleFileCapture): Promise<{ code: number | null; stdout: string; stdoutBytes: Uint8Array; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      "compile", "--format=json", `--catalog=${catalog}`, capture.compilerOperand,
    ], {
      cwd: capture.root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CAN_CATALOG: catalog },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let failed: Error | null = null;
    const timer = setTimeout(() => {
      failed = new Error("compiler timed out");
      child.kill();
    }, COMPILER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        failed = new Error("compiler output exceeded limit");
        child.kill();
      } else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > MAX_STDERR_BYTES) {
        failed = new Error("compiler stderr exceeded limit");
        child.kill();
      } else err.push(chunk);
    });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      if (failed !== null) reject(failed);
      else {
        const stdoutBytes = Buffer.concat(out);
        resolve({ code, stdout: stdoutBytes.toString("utf8"), stdoutBytes,
          stderr: Buffer.concat(err).toString("utf8") });
      }
    });
  });
}

/**
 * Compile with exact captured compiler and catalog bytes, then verify the
 * compiler's consumed one-file source identity before returning any result.
 * The caller still owns one-file profile admission and preview bundle inputs.
 */
export async function compileCapturedSingleFile(capture: SingleFileCapture): Promise<CapturedCompileResult> {
  const profile = admitSingleAppProfile(capture.sourceText);
  if (!profile.ok) return { kind: "profile_unsupported", reason: profile.reason, capture };
  if (basename(capture.compilerOperand).startsWith("-")) {
    return { kind: "capture_incomplete", reason: "source filename cannot be a compiler option", capture };
  }
  let compilerBytes: Buffer;
  let catalogBytes: Buffer;
  try {
    compilerBytes = await verifiedBytes(input(capture, "compiler"));
    catalogBytes = await verifiedBytes(input(capture, "catalog"));
  } catch (error) {
    return { kind: "capture_incomplete", reason: error instanceof Error ? error.message : String(error), capture };
  }
  const staging = await mkdtemp(join(tmpdir(), "can-dev-compiler-"));
  try {
    const executable = join(staging, "can");
    const catalog = join(staging, "catalog.json");
    await writeFile(executable, compilerBytes, { mode: 0o700 });
    await writeFile(catalog, catalogBytes, { mode: 0o600 });
    let run: Awaited<ReturnType<typeof runStagedCompiler>>;
    try {
      run = await runStagedCompiler(executable, catalog, capture);
    } catch (error) {
      return { kind: "tool_failure", reason: error instanceof Error ? error.message : String(error), capture };
    }
    if (!(await captureIsCurrent(capture))) {
      return { kind: "capture_incomplete", reason: "inputs changed during compiler execution", capture };
    }
    if (run.code !== 0 && run.code !== 10) {
      return { kind: "tool_failure", reason: `compiler exited ${run.code ?? "without status"}: ${run.stderr.slice(0, 400)}`, capture };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stdout) as unknown;
    } catch {
      return { kind: "tool_failure", reason: "compiler returned invalid JSON", capture };
    }
    if (run.code === 0) {
      try {
        const artifact = parseArtifactText(run.stdout, `captured:${capture.compilerOperand}`).artifact;
        const sources = artifact.sources.map(source => ({ path: source.path, sha256: source.sha256 }));
        const verdict = verifyCompilerSources(capture, { complete: true, sources });
        if (!verdict.ok) return { kind: "capture_incomplete", reason: verdict.reason, capture };
        return { kind: "artifact", artifact, artifactBytes: new Uint8Array(run.stdoutBytes), capture };
      } catch (error) {
        return { kind: "tool_failure", reason: error instanceof Error ? error.message : String(error), capture };
      }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { kind: "tool_failure", reason: "compiler diagnostics envelope is not an object", capture };
    }
    const envelope = parsed as CompilerSourceReport & { readonly diagnostics?: readonly unknown[] };
    const verdict = verifyCompilerSources(capture, envelope);
    if (!verdict.ok) return { kind: "capture_incomplete", reason: verdict.reason, capture };
    if (!Array.isArray(envelope.diagnostics)) {
      return { kind: "tool_failure", reason: "compiler diagnostics are missing", capture };
    }
    return { kind: "diagnostics", envelope: envelope as CompilerSourceReport & { readonly diagnostics: readonly unknown[] }, capture };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
