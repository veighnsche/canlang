/**
 * Executable manifest inventory (P09.1): supported-host list derived
 * from install claims, plus manifest sidecar load/verify for staged
 * or installed bundles. Pairs with `executable.ts` (resolution order
 * + spawning): this module answers "what do we ship and is this copy
 * intact", the launcher answers "where is it and how do we run it".
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SupportedHost {
  triple: string;
  /** Install claim this triple derives from. */
  claim: string;
  binary: string;
}

/** Supported release hosts; Windows stays mapped but unclaimed. */
export const SUPPORTED_HOSTS: readonly SupportedHost[] = [
  { triple: "linux-x64-gnu", claim: "docs/install.md can-linux-x86_64", binary: "can-preparation" },
  { triple: "darwin-arm64", claim: "docs/install.md can-macos-aarch64", binary: "can-preparation" },
];

export function isSupportedTriple(triple: string): boolean {
  return SUPPORTED_HOSTS.some((host) => host.triple === triple);
}

export interface ExecutableManifest {
  triple: string;
  binary: string;
  sha256: string;
  bytes: number;
  toolchain: { rustc: string; cargo: string; pinned: string };
  lockfileSha256: string;
  sourceHead: string;
  release: string;
}

export class ManifestError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`executable-manifest: ${detail}`);
    this.name = "ManifestError";
    this.code = code;
  }
}

function isManifest(value: unknown): value is ExecutableManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m["triple"] !== "string") return false;
  if (typeof m["binary"] !== "string") return false;
  if (typeof m["sha256"] !== "string") return false;
  if (typeof m["bytes"] !== "number") return false;
  if (typeof m["lockfileSha256"] !== "string") return false;
  if (typeof m["sourceHead"] !== "string") return false;
  if (typeof m["release"] !== "string") return false;
  const toolchain = m["toolchain"] as Record<string, unknown> | undefined;
  return (
    typeof toolchain === "object" &&
    toolchain !== null &&
    typeof toolchain["rustc"] === "string" &&
    typeof toolchain["cargo"] === "string" &&
    typeof toolchain["pinned"] === "string"
  );
}

/** Load + shape-check a bundle's `manifest.json`. */
export async function loadExecutableManifest(dir: string): Promise<ExecutableManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as unknown;
  } catch (error) {
    throw new ManifestError(
      "manifest-unreadable",
      `${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isManifest(parsed)) {
    throw new ManifestError("manifest-malformed", `${dir}/manifest.json is not a manifest`);
  }
  return parsed;
}

/**
 * Verify a staged/installed bundle directory: sidecar triple match,
 * binary present + executable, sha + bytes match, toolchain pin
 * match. Returns the manifest. Liveness (readiness probe) stays in
 * `host.ts probeReadiness`, which takes the verified binary path.
 */
export async function verifyExecutableManifest(
  dir: string,
  triple: string,
): Promise<ExecutableManifest> {
  const manifest = await loadExecutableManifest(dir);
  if (manifest.triple !== triple) {
    throw new ManifestError(
      "manifest-triple",
      `want ${triple}, manifest says ${manifest.triple}`,
    );
  }
  const binary = join(dir, manifest.binary);
  try {
    const info = await stat(binary);
    if (!info.isFile()) throw new Error("not a file");
    await access(binary, constants.X_OK);
  } catch {
    throw new ManifestError("manifest-binary", `${binary} is not an executable file`);
  }
  const bytes = await readFile(binary);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== manifest.sha256 || bytes.length !== manifest.bytes) {
    throw new ManifestError(
      "manifest-hash",
      `${binary}: want sha ${manifest.sha256} (${manifest.bytes} bytes), got ${sha} (${bytes.length})`,
    );
  }
  if (manifest.toolchain.pinned !== "1.99.0") {
    throw new ManifestError(
      "manifest-toolchain",
      `pinned toolchain ${manifest.toolchain.pinned}, want 1.99.0`,
    );
  }
  return manifest;
}
