#!/usr/bin/env node
/**
 * Verify a staged preparation bundle (P09.2, C04.native-release).
 *
 * Reuses the owning launch-time verifiers against one stage dir —
 * default `dist/preparation/<host triple>` — with no compiler, Cargo,
 * or source crate involved:
 *   1. `verifyExecutableManifest` (triple, executable bit, sha256+bytes),
 *   2. owning `RELEASE_VERSION` skew check (same comparison the launch
 *      guard enforces before any spawn),
 *   3. `probeReadiness` handshake on a fresh process (bounded deadline).
 * Fails loud (non-zero exit) naming the defect; prints a JSON summary
 * on success. Never builds, packages, or deploys.
 *
 * Usage: node packages/cloudflare/scripts/verify-preparation.mjs [--dir <stageDir>]
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { binaryName, hostTriple } from "./build-preparation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const DIST = join(PACKAGE_ROOT, "dist");

async function main() {
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf("--dir");
  const triple = hostTriple();
  const dir = dirFlag >= 0 ? resolve(argv[dirFlag + 1]) : join(DIST, "preparation", triple);
  const { verifyExecutableManifest } = await import(
    join(DIST, "preparation", "executable-manifest.js")
  );
  const { probeReadiness } = await import(join(DIST, "preparation", "host.js"));
  const { RELEASE_VERSION } = await import(join(DIST, "release", "stamp.js"));
  const manifest = await verifyExecutableManifest(dir, triple);
  if (manifest.release !== RELEASE_VERSION) {
    throw new Error(
      `release skew: manifest pins ${manifest.release} (want ${RELEASE_VERSION}): rebuild the preparation binary`,
    );
  }
  const binary = join(dir, manifest.binary);
  const ready = await probeReadiness(binary);
  if (ready !== true) {
    throw new Error(`readiness probe refused ${binaryName(triple)} (got ${ready})`);
  }
  console.log(
    JSON.stringify({
      ok: true,
      dir,
      triple,
      binary: manifest.binary,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      release: manifest.release,
    }),
  );
}

try {
  await main();
} catch (error) {
  console.error(`verify-preparation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
