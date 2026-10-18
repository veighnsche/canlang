/**
 * One-file source capture for the first `can dev` profile.
 *
 * The capture is immutable input evidence, not project discovery. The session
 * owner must admit a self-contained app, invoke the compiler from `root` with
 * `compilerOperand`, pin its catalog/binary inputs, and use both verification
 * functions before publishing a current result. A compiler result by itself
 * cannot prove the selected profile's source closure is complete.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FileHandle } from "node:fs/promises";

const MAX_SOURCE_BYTES = 0xffff_ffff;
const SHA256 = /^[0-9a-f]{64}$/;
const INPUT_READERS = 8;
const MAX_INPUT_BYTES = 1024 * 1024 * 1024;
const HASH_CHUNK_BYTES = 256 * 1024;

export interface NamedInputPath {
  /** Stable identity within its kind, such as a package export path. */
  name: string;
  path: string;
}

export interface SingleFileCaptureRequest {
  checkoutRoot: string;
  appPath: string;
  profile: string;
  compilerPath: string;
  /** Null records an explicitly missing catalog; it is not a fallback lookup. */
  catalogPath: string | null;
  helpIndexPath: string;
  /** The caller supplies every package output the selected profile consumes. */
  packageInputPaths: readonly NamedInputPath[];
  /** Additional input files with stable names, if this profile consumes any. */
  extraInputPaths?: readonly NamedInputPath[];
  /** Semantic flags that change analysis or emission. */
  semanticOptions?: Readonly<Record<string, string>>;
  /** Re-discover the installed local producer inventory on every currency check. */
  inputInventory?: "installed-local-preview";
}

export interface CapturedFileIdentity {
  name: string;
  requestedPath: string | null;
  canonicalPath: string | null;
  sha256: string | null;
  bytes: number | null;
  state: "present" | "missing";
}

export interface SingleFileCapture {
  requestedRoot: string;
  root: string;
  requestedAppPath: string;
  appPath: string;
  /** Relative to `root`; invoke `can` from `root` with this exact operand. */
  compilerOperand: string;
  /** Exact decoded UTF-8 bytes, including original line endings. */
  sourceText: string;
  sourceSha256: string;
  sourceBytes: number;
  /** Source membership and bytes only. The session assigns a monotonic epoch. */
  sourceRevision: string;
  /** Digest of source, root, profile, options and all named input identities. */
  epochMaterial: string;
  profile: string;
  semanticOptions: Readonly<Record<string, string>>;
  inputs: readonly CapturedFileIdentity[];
  inputInventory?: "installed-local-preview";
  /** Compiler-owned generated closure copied under cooperative read leases. */
  generatedClosure?: import("./generated-capture.js").GeneratedClosure;
  sourceSnapshot?: readonly import("../generation/journal.js").ConsumedInput[];
}

export interface CompilerSourceEntry {
  path: string;
  sha256: string;
}

export interface CompilerSourceReport {
  complete: boolean;
  sources: readonly CompilerSourceEntry[];
}

export type CompilerCaptureVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: "analysis_incomplete" | "source_membership_mismatch" | "source_path_mismatch" | "source_hash_mismatch";
    };

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length).update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function normalizedOptions(options: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  const ordered: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(options ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!name || typeof value !== "string") throw new Error("semantic options need nonempty names and string values");
    ordered[name] = value;
  }
  return Object.freeze(ordered);
}

async function readStable<T>(requestedPath: string,
  read: (handle: FileHandle, size: number) => Promise<{ value: T; bytes: number }>,
): Promise<{ canonicalPath: string; value: T }> {
  const canonicalPath = await realpath(requestedPath);
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`input is not a regular file: ${requestedPath}`);
    const result = await read(handle, before.size);
    const afterHandle = await handle.stat();
    const after = await stat(canonicalPath);
    if (
      before.dev !== afterHandle.dev ||
      before.ino !== afterHandle.ino ||
      before.size !== afterHandle.size ||
      before.mtimeMs !== afterHandle.mtimeMs ||
      before.ctimeMs !== afterHandle.ctimeMs ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      result.bytes !== after.size ||
      afterHandle.mtimeMs !== after.mtimeMs ||
      afterHandle.ctimeMs !== after.ctimeMs ||
      (await realpath(requestedPath)) !== canonicalPath
    ) {
      throw new Error(`input changed during capture: ${requestedPath}`);
    }
    return { canonicalPath, value: result.value };
  } finally {
    await handle.close();
  }
}

async function readStableFile(requestedPath: string): Promise<{ canonicalPath: string; bytes: Buffer }> {
  const result = await readStable(requestedPath, async (handle, size) => {
    if (size > MAX_SOURCE_BYTES) throw new Error("selected source exceeds compiler byte-offset range");
    const bytes = await handle.readFile();
    return { value: bytes, bytes: bytes.length };
  });
  return { canonicalPath: result.canonicalPath, bytes: result.value };
}

/** Bound each producer input and memory use, including installed browser binaries. */
async function readStableIdentity(requestedPath: string): Promise<{ canonicalPath: string; bytes: number; sha256: string }> {
  const result = await readStable(requestedPath, async (handle, size) => {
    if (size > MAX_INPUT_BYTES) throw new Error("capture input exceeds the finite 1 GiB limit");
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(Math.max(1, Math.min(size, HASH_CHUNK_BYTES)));
    let bytes = 0;
    while (true) {
      const read = await handle.read(chunk, 0, chunk.length, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > MAX_INPUT_BYTES) throw new Error("capture input exceeds the finite 1 GiB limit");
      if (bytes > size) throw new Error(`input changed during capture: ${requestedPath}`);
      hash.update(chunk.subarray(0, read.bytesRead));
    }
    return { value: { bytes, sha256: hash.digest("hex") }, bytes };
  });
  return { canonicalPath: result.canonicalPath, ...result.value };
}

function withinRoot(root: string, child: string): string {
  const path = relative(root, child);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`selected app escapes checkout root: ${child}`);
  }
  if (!path.endsWith(".can")) throw new Error(`selected app must be a .can file: ${child}`);
  return path;
}

function namedPaths(request: SingleFileCaptureRequest): { name: string; path: string | null }[] {
  if (!request.compilerPath || !request.helpIndexPath || request.packageInputPaths.length === 0) {
    throw new Error("compiler, help index and at least one package output are required capture inputs");
  }
  const paths = [
    { name: "compiler", path: request.compilerPath },
    { name: "catalog", path: request.catalogPath },
    { name: "help-index", path: request.helpIndexPath },
    ...request.packageInputPaths.map((input) => ({ name: `package:${input.name}`, path: input.path })),
    ...(request.extraInputPaths ?? []).map((input) => ({ name: `extra:${input.name}`, path: input.path })),
  ];
  const names = new Set<string>();
  for (const input of paths) {
    if (!input.name || input.name.endsWith(":") || (input.path !== null && !input.path)) {
      throw new Error("capture input names and paths must be nonempty");
    }
    if (names.has(input.name)) throw new Error(`duplicate capture input: ${input.name}`);
    names.add(input.name);
  }
  return paths.sort((a, b) => a.name.localeCompare(b.name));
}

/** Bound open descriptors and await every started reader before a failure escapes. */
async function mapInputs<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  const failures: Array<{ index: number; error: unknown }> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failures.length === 0 && next < items.length) {
      const index = next++;
      try { results[index] = await read(items[index]!); }
      catch (error) { failures.push({ index, error }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(INPUT_READERS, items.length) }, () => worker()));
  if (failures.length > 0) {
    failures.sort((a, b) => a.index - b.index);
    throw failures[0]!.error;
  }
  return results;
}

export async function captureInputs(root: string, paths: readonly { name: string; path: string | null }[]): Promise<readonly CapturedFileIdentity[]> {
  const inputs = await mapInputs(paths, async (input): Promise<CapturedFileIdentity> => {
    if (input.path === null) {
      return Object.freeze({
        name: input.name, requestedPath: null, canonicalPath: null,
        sha256: null, bytes: null, state: "missing" as const,
      });
    }
    const requestedPath = resolve(root, input.path);
    const { canonicalPath, bytes, sha256 } = await readStableIdentity(requestedPath);
    return Object.freeze({
      name: input.name,
      requestedPath,
      canonicalPath,
      sha256,
      bytes,
      state: "present" as const,
    });
  });
  return Object.freeze(inputs);
}

function epochMaterial(capture: Pick<SingleFileCapture, "root" | "compilerOperand" | "sourceRevision" | "profile" | "semanticOptions" | "inputs">): string {
  return digest([
    "can.dev.capture-epoch.v1",
    capture.root,
    capture.compilerOperand,
    capture.sourceRevision,
    capture.profile,
    String(Object.keys(capture.semanticOptions).length),
    ...Object.entries(capture.semanticOptions).flatMap(([key, value]) => [key, value]),
    String(capture.inputs.length),
    ...capture.inputs.flatMap((input) => [
      input.name, input.state, input.canonicalPath ?? "", input.sha256 ?? "", String(input.bytes ?? ""),
    ]),
  ]);
}

/** Capture one canonical `.can` file and every caller-declared non-source input. */
export async function captureSingleFileSource(request: SingleFileCaptureRequest): Promise<SingleFileCapture> {
  if (!request.profile) throw new Error("a capture profile is required");
  const root = await realpath(request.checkoutRoot);
  if (!(await stat(root)).isDirectory()) throw new Error(`checkout root is not a directory: ${root}`);
  const requestedAppPath = resolve(root, request.appPath);
  const { canonicalPath: appPath, bytes } = await readStableFile(requestedAppPath);
  const compilerOperand = withinRoot(root, appPath);
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("selected source exceeds compiler byte-offset range");
  const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const sourceRevision = digest(["can.dev.source-set.v1", compilerOperand, sourceSha256]);
  const semanticOptions = normalizedOptions(request.semanticOptions);
  const browserInputs = request.inputInventory === "installed-local-preview"
    ? await (await import("./preview-inputs.js")).installedBrowserQualificationInputs(root) : [];
  const declaredPaths = namedPaths({ ...request,
    extraInputPaths: [...(request.extraInputPaths ?? []), ...browserInputs],
  });
  if (!(await inventoryMatches(request.inputInventory, root, declaredPaths, request.compilerPath))) {
    throw new Error("installed preview input membership changed before capture");
  }
  let inputs = await captureInputs(root, declaredPaths);
  let generatedClosure: import("./generated-capture.js").GeneratedClosure | undefined;
  let sourceSnapshot: readonly import("../generation/journal.js").ConsumedInput[] | undefined;
  if (request.inputInventory === "installed-local-preview" && /\$(?:"|[A-Za-z_])/.test(sourceText)) {
    const generation = await import("./generated-capture.js");
    generatedClosure = await generation.discoverGeneratedClosure(resolve(root, request.compilerPath), root, appPath);
    sourceSnapshot = await generation.snapshotGeneratedClosure(root, appPath, generatedClosure);
    if (sourceSnapshot.find(input => input.path === compilerOperand)?.sha256 !== sourceSha256) throw new Error("Source changed during generated capture");
    const generatedInputs = await captureInputs(root, generatedClosure.files.filter(input => input.path !== compilerOperand)
      .map(input => ({name: `generated:${input.path}`, path: input.path})));
    if (generatedInputs.some(input => sourceSnapshot!.find(saved => saved.path === input.name.slice("generated:".length))?.sha256 !== input.sha256)) {
      throw new Error("Saved generation inputs changed during capture");
    }
    inputs = Object.freeze([...inputs, ...generatedInputs]);
  }
  if ((await realpath(request.checkoutRoot)) !== root || (await realpath(requestedAppPath)) !== appPath) {
    throw new Error("selected checkout or app path changed during capture");
  }
  const capture = {
    requestedRoot: request.checkoutRoot,
    root,
    requestedAppPath,
    appPath,
    compilerOperand,
    sourceText,
    sourceSha256,
    sourceBytes: bytes.length,
    sourceRevision,
    epochMaterial: "",
    profile: request.profile,
    semanticOptions,
    inputs,
    ...(generatedClosure === undefined || sourceSnapshot === undefined ? {} : { generatedClosure, sourceSnapshot }),
    ...(request.inputInventory === undefined ? {} : { inputInventory: request.inputInventory }),
  };
  if (!(await inventoryMatches(request.inputInventory, root, declaredPaths, request.compilerPath))) {
    throw new Error("installed preview input membership changed during capture");
  }
  capture.epochMaterial = epochMaterial(capture);
  return Object.freeze(capture);
}

async function inventoryMatches(
  kind: SingleFileCaptureRequest["inputInventory"], root: string,
  selected: readonly { name: string; path: string | null }[], compilerPath: string,
  runtimeOnly = false,
): Promise<boolean> {
  if (kind === undefined) return true;
  if (kind !== "installed-local-preview") return false;
  try {
    const inputs = await import("./preview-inputs.js");
    let current;
    if (runtimeOnly) {
      const packageInputPaths = inputs.installedPortableBundleInputs(root);
      current = { packageInputPaths, extraInputPaths: inputs.installedOwnedSourceInputs(root, packageInputPaths) };
    } else {
      current = inputs.installedLocalPreviewInputInventory(root, compilerPath);
    }
    const browserInputs = runtimeOnly ? [] : await inputs.installedBrowserQualificationInputs(root);
    const expected = [
      ...current.packageInputPaths.map(item => ({ name: `package:${item.name}`, path: item.path })),
      ...[...current.extraInputPaths, ...browserInputs]
        .filter(item => !runtimeOnly || item.name.startsWith("source:"))
        .map(item => ({ name: `extra:${item.name}`, path: item.path })),
    ];
    const actual = runtimeOnly ? selected.filter(input => isRuntimeInput(input) && !input.name.startsWith("generated:")) : selected.filter(isCapturedInput);
    if (actual.length !== expected.length) return false;
    const byName = new Map(actual.map(item => [item.name, item.path]));
    const matches = await mapInputs(expected, async (item): Promise<boolean> => {
      const path = byName.get(item.name);
      return path !== undefined && path !== null &&
        (await realpath(resolve(root, path))) === (await realpath(item.path));
    });
    return matches.every(Boolean);
  } catch {
    return false;
  }
}

function isRuntimeInput(input: Pick<CapturedFileIdentity, "name">): boolean {
  return input.name.startsWith("package:") || input.name.startsWith("extra:source:") || input.name.startsWith("generated:");
}

function isCapturedInput(input: Pick<CapturedFileIdentity, "name">): boolean {
  return input.name.startsWith("package:") || input.name.startsWith("extra:");
}

/**
 * Compare the compiler's actual consumed source set with the capture. The
 * caller separately admits the one-file language profile and checks current
 * disk/input identity before promoting the result.
 */
export function verifyCompilerSources(capture: SingleFileCapture, report: CompilerSourceReport): CompilerCaptureVerdict {
  if (report.complete !== true) return { ok: false, reason: "analysis_incomplete" };
  const expected = new Map([[capture.compilerOperand, capture.sourceSha256]]);
  for (const path of capture.generatedClosure?.compilerSources ?? []) {
    if (path === capture.compilerOperand) continue;
    const physical = relative(capture.root, resolve(capture.generatedClosure!.root, path)).split(sep).join("/");
    const input = capture.inputs.find(input => input.name === `generated:${physical}`);
    if (input?.sha256 === null || input?.sha256 === undefined) return {ok: false, reason: "source_membership_mismatch"};
    expected.set(path, input.sha256);
  }
  if (!Array.isArray(report.sources) || report.sources.length !== expected.size) {
    return { ok: false, reason: "source_membership_mismatch" };
  }
  const seen = new Set<string>();
  for (const source of report.sources) {
    if (!expected.has(source.path) || seen.has(source.path)) return { ok: false, reason: "source_path_mismatch" };
    seen.add(source.path);
    if (!SHA256.test(source.sha256) || source.sha256 !== expected.get(source.path)) return { ok: false, reason: "source_hash_mismatch" };
  }
  return { ok: true };
}

/** Recheck source, symlink targets and all declared inputs before publication. */
export async function captureIsCurrent(capture: SingleFileCapture): Promise<boolean> {
  try {
    if (!(await capturedProducerInputsAreCurrent(capture))) return false;
    const { canonicalPath, bytes } = await readStableFile(capture.requestedAppPath);
    if (canonicalPath !== capture.appPath || bytes.length !== capture.sourceBytes) return false;
    if (createHash("sha256").update(bytes).digest("hex") !== capture.sourceSha256) return false;
    return true;
  } catch {
    return false;
  }
}

/** Compiler/help/qualification and runtime inputs, independent of app edits. */
export async function capturedProducerInputsAreCurrent(capture: SingleFileCapture): Promise<boolean> {
  return capturedInputsAreCurrent(capture,capture.inputs);
}

/** An old artifact may rerun after a source edit, but never through changed producers. */
export async function capturedRuntimeInputsAreCurrent(capture: SingleFileCapture): Promise<boolean> {
  return capturedInputsAreCurrent(capture, capture.inputs.filter(isRuntimeInput), true);
}

async function capturedInputsAreCurrent(
  capture: SingleFileCapture,
  inputs: readonly CapturedFileIdentity[],
  runtimeOnly = false,
): Promise<boolean> {
  try {
    if ((await realpath(capture.requestedRoot)) !== capture.root ||
        !(await inventoryMatches(capture.inputInventory, capture.root,
          capture.inputs.map(input => ({ name: input.name, path: input.requestedPath })),
          capture.inputs.find(input => input.name === "compiler")?.requestedPath ?? "",
          runtimeOnly))) return false;
    if (capture.generatedClosure !== undefined) {
      const discovered = await (await import("./generated-capture.js")).discoverGeneratedClosure(
        capture.inputs.find(input => input.name === "compiler")!.requestedPath!, capture.root, capture.appPath);
      if (JSON.stringify(discovered) !== JSON.stringify(capture.generatedClosure)) return false;
    }
    const current = await mapInputs(inputs, async (input): Promise<boolean> => {
      if (input.requestedPath === null) {
        return input.state === "missing";
      }
      if (input.state === "missing") {
        try { await stat(input.requestedPath); return false; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
          return true;
        }
      }
      const checked = await readStableIdentity(input.requestedPath);
      return checked.canonicalPath === input.canonicalPath && checked.bytes === input.bytes &&
        checked.sha256 === input.sha256;
    });
    return current.every(Boolean);
  } catch { return false; }
}
