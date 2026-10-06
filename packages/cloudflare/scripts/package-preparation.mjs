#!/usr/bin/env node
/**
 * Package a staged preparation bundle for release (P09.1).
 *
 * Reads the `build-preparation.mjs` stage dir and writes release
 * metadata beside it: per-host inventory entry, integrity record,
 * protocol/release metadata, and the dependency license table.
 * Guards: supported hosts derive from install claims (see
 * executable-manifest.ts); the bundle must not be vendored into
 * Workers (no `preparation/` reference under the served worker
 * roots). Normal installation uses prebuilt executables — this
 * script never compiles.
 *
 * Usage: node packages/cloudflare/scripts/package-preparation.mjs [--triple T]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryName, hostTriple } from "./build-preparation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const CRATE_DIR = join(PACKAGE_ROOT, "preparation");

/** Supported hosts derive from docs/install.md release claims. */
export const SUPPORTED_TRIPLES = ["linux-x64-gnu", "darwin-arm64"];
export const TRIPLE_CLAIMS = {
  "linux-x64-gnu": "docs/install.md can-linux-x86_64",
  "darwin-arm64": "docs/install.md can-macos-aarch64",
};

function walkRel(dir, base = "") {
  const out = [];
  for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkRel(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** No `preparation/` reference may sit under served worker roots. */
export function assertNotVendoredIntoWorkers(distDir) {
  const roots = ["worker", "runtime"].map((d) => join(distDir, d)).filter((d) => existsSync(d));
  const hits = [];
  for (const root of roots) {
    for (const rel of walkRel(root)) {
      if (!rel.endsWith(".js") && !rel.endsWith(".mjs")) continue;
      const text = readFileSync(join(root, rel), "utf8");
      if (text.includes("preparation/") || text.includes("can-preparation")) {
        hits.push(`${root}/${rel}`);
      }
    }
  }
  if (hits.length > 0) {
    throw new Error(
      `native bundle would be vendored into Workers; references in: ${hits.join(", ")}`,
    );
  }
  return roots.length;
}

/** Dependency license table from cargo metadata (offline-safe). */
export function licenseTable() {
  const out = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--offline"],
    { encoding: "utf8", cwd: CRATE_DIR },
  );
  const meta = JSON.parse(out);
  const root = meta.packages.find((p) => p.name === "can-preparation");
  const table = [{ crate: "can-preparation", version: root?.version ?? "?", license: root?.license ?? "?" }];
  // Locked transitive set with licenses from the registry cache.
  const full = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--offline"], {
      encoding: "utf8",
      cwd: CRATE_DIR,
    }),
  );
  for (const pkg of full.packages) {
    if (pkg.name === "can-preparation") continue;
    if (pkg.source === null) continue; // path-only root crate already recorded
    table.push({ crate: pkg.name, version: pkg.version, license: pkg.license ?? "?" });
  }
  table.sort((a, b) => (a.crate < b.crate ? -1 : 1));
  const unknown = table.filter((row) => row.license === "?");
  if (unknown.length > 0) {
    throw new Error(`unlicensed crates in lockfile: ${unknown.map((r) => r.crate).join(", ")}`);
  }
  return table;
}

export function packageBundle({ triple = hostTriple(), outDir = join(PACKAGE_ROOT, "dist") } = {}) {
  if (!SUPPORTED_TRIPLES.includes(triple)) {
    throw new Error(
      `triple ${triple} is not a supported release host (supported: ${SUPPORTED_TRIPLES.join(", ")} per install claims)`,
    );
  }
  const stageDir = join(outDir, "preparation", triple);
  const sidecarPath = join(stageDir, "manifest.json");
  if (!existsSync(sidecarPath)) {
    throw new Error(`no staged bundle for ${triple} (run build-preparation.mjs first)`);
  }
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  const binary = join(stageDir, binaryName(triple));
  if (!existsSync(binary) || !statSync(binary).isFile()) {
    throw new Error(`staged binary missing at ${binary}`);
  }
  const workerRootsScanned = assertNotVendoredIntoWorkers(outDir);
  const licenses = licenseTable();
  writeFileSync(join(stageDir, "licenses.json"), JSON.stringify(licenses, null, 2) + "\n");
  const releaseMeta = {
    triple,
    claim: TRIPLE_CLAIMS[triple],
    install: "prebuilt executable (no source build at install time)",
    protocol: { name: "can-preparation", version: 1 },
    release: sidecar.release,
    binary: { file: binaryName(triple), sha256: sidecar.sha256, bytes: sidecar.bytes },
    toolchain: sidecar.toolchain,
    lockfileSha256: sidecar.lockfileSha256,
    sourceHead: sidecar.sourceHead,
    licenseFiles: ["licenses.json"],
    workerVendoringGuard: { scannedRoots: workerRootsScanned, hits: 0 },
  };
  writeFileSync(join(stageDir, "release.json"), JSON.stringify(releaseMeta, null, 2) + "\n");
  return { stageDir, releaseMeta, licenses: licenses.length };
}

function main() {
  const argv = process.argv.slice(2);
  const tripleFlag = argv.indexOf("--triple");
  try {
    const { stageDir, licenses } = packageBundle(
      tripleFlag >= 0 ? { triple: argv[tripleFlag + 1] } : {},
    );
    console.log(JSON.stringify({ ok: true, stageDir, licenses }));
  } catch (error) {
    console.error(`package-preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
