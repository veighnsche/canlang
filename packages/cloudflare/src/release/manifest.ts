/**
 * B5-J3 dist manifest: content-hash proof that a build is reproducible.
 *
 * `buildDistManifest` walks the given dist dirs (repo-root-relative),
 * hashes every emitted file with sha256, and returns the sorted manifest.
 * `writeDistManifest` persists it as `dist-manifest.json` at the repo
 * root; `verifyDistManifest` re-hashes and fails loud naming every
 * changed/missing/added file. Rebuild twice -> byte-identical manifest.
 *
 * Composite `*.tsbuildinfo` files are EXCLUDED (they carry timestamps by
 * design); everything else under the scanned roots is covered, so an
 * untracked emit or a hand edit breaks verification loudly.
 *
 * Direct-run: `node dist/release/manifest.js` writes the manifest over
 * every `packages/<pkg>/dist` dir that exists; `--verify` verifies
 * instead. Exit 0 on success, exit 1 with the mismatch list.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_VERSION } from "./stamp.js";

export const DIST_MANIFEST_NAME = "dist-manifest.json";

export interface DistManifestFile {
  /** Repo-root-relative posix path, e.g. `packages/ui/dist/index.js`. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface DistManifest {
  release: string;
  /** Dist roots scanned, repo-root-relative, sorted. */
  roots: string[];
  /** Covered files, sorted by path. */
  files: DistManifestFile[];
}

function isCovered(fileName: string): boolean {
  return !fileName.endsWith(".tsbuildinfo");
}

function walk(distAbs: string, distRel: string, out: DistManifestFile[]): void {
  const entries = readdirSync(distAbs, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const abs = join(distAbs, entry.name);
    const rel = posix.join(distRel, entry.name);
    if (entry.isDirectory()) {
      walk(abs, rel, out);
    } else if (entry.isFile() && isCovered(entry.name)) {
      const bytes = readFileSync(abs);
      out.push({
        path: rel,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
    }
  }
}

/**
 * Hash every covered file under `distDirs` (repo-root-relative dirs).
 * Deterministic: roots and files sorted, fixed JSON shape. Throws loud
 * when a listed root is absent (a skipped root must never read as clean).
 */
export function buildDistManifest(repoRoot: string, distDirs: readonly string[]): DistManifest {
  const roots = [...distDirs].sort();
  const files: DistManifestFile[] = [];
  for (const root of roots) {
    const abs = join(repoRoot, root);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      throw new Error(
        `dist manifest: root ${JSON.stringify(root)} is missing (run the package builds first)`,
      );
    }
    walk(abs, root.split("/").join(posix.sep), files);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { release: RELEASE_VERSION, roots, files };
}

/** Write the manifest to `<repoRoot>/dist-manifest.json`; returns the path. */
export function writeDistManifest(repoRoot: string, manifest: DistManifest): string {
  const path = join(repoRoot, DIST_MANIFEST_NAME);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

function loadManifest(path: string): DistManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `${DIST_MANIFEST_NAME} unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { files?: unknown }).files)) {
    throw new Error(`${DIST_MANIFEST_NAME} at ${path} is not a manifest (missing files[])`);
  }
  return parsed as DistManifest;
}

/**
 * Re-hash the recorded roots and compare against the recorded manifest.
 * Throws ONE error listing EVERY mismatch (changed bytes, missing file,
 * unexpected file, release drift); passes silently on agreement.
 */
export function verifyDistManifest(repoRoot: string, manifestPath?: string): void {
  const path = manifestPath ?? join(repoRoot, DIST_MANIFEST_NAME);
  const expected = loadManifest(path);
  const problems: string[] = [];
  if (expected.release !== RELEASE_VERSION) {
    problems.push(`release: manifest pins ${expected.release}, tree stamps ${RELEASE_VERSION}`);
  }
  const actual = buildDistManifest(repoRoot, expected.roots);
  const want = new Map(expected.files.map((file) => [file.path, file]));
  const got = new Map(actual.files.map((file) => [file.path, file]));
  for (const [filePath, expectedFile] of [...want].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const actualFile = got.get(filePath);
    if (actualFile === undefined) {
      problems.push(`missing: ${filePath}`);
    } else if (actualFile.sha256 !== expectedFile.sha256) {
      problems.push(`changed: ${filePath} (bytes ${expectedFile.bytes} -> ${actualFile.bytes})`);
    }
  }
  for (const filePath of [...got.keys()].sort()) {
    if (!want.has(filePath)) problems.push(`unexpected: ${filePath}`);
  }
  if (problems.length > 0) {
    throw new Error(`${DIST_MANIFEST_NAME} verification failed:\n- ${problems.join("\n- ")}`);
  }
}

/** Every `packages/<pkg>/dist` dir that exists, repo-root-relative, sorted. */
export function discoverDistRoots(repoRoot: string): string[] {
  const roots: string[] = [];
  for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const rel = `packages/${entry.name}/dist`;
    if (existsSync(join(repoRoot, rel))) roots.push(rel);
  }
  return roots.sort();
}

function manifestMain(): void {
  // dist/release/manifest.js -> repo root is four levels up.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  if (process.argv.includes("--verify")) {
    verifyDistManifest(repoRoot);
    process.stderr.write(`${DIST_MANIFEST_NAME}: verify ok\n`);
    return;
  }
  const path = writeDistManifest(repoRoot, buildDistManifest(repoRoot, discoverDistRoots(repoRoot)));
  process.stderr.write(`${DIST_MANIFEST_NAME}: wrote ${path}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    manifestMain();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
