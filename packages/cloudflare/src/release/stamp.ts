/**
 * B5-J3 release stamp: the single release version + lockstep assertion.
 *
 * Version facts live in four places today (`can` Cargo.toml, the
 * contracts `CONTRACTS_VERSION`, the platform CLI version, and the
 * per-package `package.json` versions); nothing asserted they move
 * together. `RELEASE_VERSION` is the one pinned release; `assertLockstep`
 * fails loud with the FULL drift list when any input disagrees.
 *
 * No version bumps here: the assertion pins the CURRENT tree, including
 * the documented 0.0.0 exceptions (`@canlang/files`, `@canlang/services`,
 * `@canlang/work` retain their separately owned pre-release versions). An
 * exempt package at any OTHER version fails loud — the exemption is a
 * pin, not a pass.
 *
 * Direct-run (`node dist/release/stamp.js` from a built tree) reads the
 * tree facts and asserts; exit 0 on lockstep, exit 1 naming every drift.
 * Pure core (`assertLockstep`) takes injected inputs so tests pin it
 * without touching the filesystem.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The one release version every lockstep package must carry. */
export const RELEASE_VERSION = "0.1.0";

/** The contracts version this release was built against. */
export const RELEASE_CONTRACTS_VERSION = 1;

/**
 * Documented 0.0.0 exceptions: separately versioned pre-release packages. Each maps to
 * its ONLY accepted version; anything else fails loud via assertLockstep.
 */
export const LOCKSTEP_EXEMPT_PACKAGES: Readonly<Record<string, string>> = {
  "@canlang/files": "0.0.0",
  "@canlang/services": "0.0.0",
  "@canlang/work": "0.0.0",
};

export interface LockstepInputs {
  rootVersion: string;
  platformVersion: string;
  compilerVersion: string;
  contractsVersion: number;
  /** Package name -> version for every workspace package. */
  packageVersions: Readonly<Record<string, string>>;
}

export interface TreeVersions {
  rootVersion: string;
  compilerVersion: string;
  packageVersions: Record<string, string>;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Read the tree facts `assertLockstep` needs (everything except the two
 * compiled-in constants the caller passes: `PLATFORM_CLI_VERSION` and
 * `CONTRACTS_VERSION`). `repoRoot` is the checkout root.
 */
export function readLockstepInputs(repoRoot: string): TreeVersions {
  const rootPkg = readJson(join(repoRoot, "package.json"));
  const cargo = readFileSync(join(repoRoot, "compiler", "Cargo.toml"), "utf8");
  const cargoVersion = /^version\s*=\s*"([^"]+)"\s*$/m.exec(cargo)?.[1];
  if (cargoVersion === undefined) {
    throw new Error(`release stamp: no parseable version in ${join(repoRoot, "compiler", "Cargo.toml")}`);
  }
  const packageVersions: Record<string, string> = {};
  for (const entry of readdirSync(join(repoRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(repoRoot, "packages", entry.name, "package.json");
    let pkg: Record<string, unknown>;
    try {
      pkg = readJson(pkgPath);
    } catch {
      continue;
    }
    if (typeof pkg["name"] === "string" && typeof pkg["version"] === "string") {
      packageVersions[pkg["name"]] = pkg["version"];
    }
  }
  if (typeof rootPkg["version"] !== "string") {
    throw new Error("release stamp: root package.json carries no string version");
  }
  return { rootVersion: rootPkg["version"], compilerVersion: cargoVersion, packageVersions };
}

/**
 * Assert every version input matches the release pin. Throws ONE error
 * listing EVERY drift (never the first only); exempt packages must sit
 * exactly on their documented 0.0.0 pin.
 */
export function assertLockstep(inputs: LockstepInputs): void {
  const drifts: string[] = [];
  if (inputs.rootVersion !== RELEASE_VERSION) {
    drifts.push(`root package.json: ${JSON.stringify(inputs.rootVersion)} (want ${RELEASE_VERSION})`);
  }
  if (inputs.platformVersion !== RELEASE_VERSION) {
    drifts.push(`platform CLI: ${JSON.stringify(inputs.platformVersion)} (want ${RELEASE_VERSION})`);
  }
  if (inputs.compilerVersion !== RELEASE_VERSION) {
    drifts.push(`compiler (can): ${JSON.stringify(inputs.compilerVersion)} (want ${RELEASE_VERSION})`);
  }
  if (inputs.contractsVersion !== RELEASE_CONTRACTS_VERSION) {
    drifts.push(
      `contracts: v${inputs.contractsVersion} (want v${RELEASE_CONTRACTS_VERSION})`,
    );
  }
  for (const name of Object.keys(inputs.packageVersions).sort()) {
    const version = inputs.packageVersions[name] as string;
    const exempt = LOCKSTEP_EXEMPT_PACKAGES[name];
    if (exempt !== undefined) {
      if (version !== exempt) {
        drifts.push(
          `${name}: ${JSON.stringify(version)} (exempt packages must sit exactly on ${exempt})`,
        );
      }
      continue;
    }
    if (version !== RELEASE_VERSION) {
      drifts.push(`${name}: ${JSON.stringify(version)} (want ${RELEASE_VERSION})`);
    }
  }
  if (drifts.length > 0) {
    throw new Error(`release lockstep failed for ${RELEASE_VERSION}:\n- ${drifts.join("\n- ")}`);
  }
}

async function stampMain(): Promise<void> {
  // dist/release/stamp.js -> repo root is four levels up.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const tree = readLockstepInputs(repoRoot);
  const platformVersion = tree.packageVersions["@canlang/cloudflare"];
  if (platformVersion === undefined) {
    throw new Error("release stamp: @canlang/cloudflare has no version in the tree");
  }
  const contracts = (await import("@canlang/contracts")) as { CONTRACTS_VERSION: number };
  assertLockstep({
    rootVersion: tree.rootVersion,
    platformVersion,
    compilerVersion: tree.compilerVersion,
    contractsVersion: contracts.CONTRACTS_VERSION,
    packageVersions: tree.packageVersions,
  });
  process.stderr.write(`release lockstep: ${RELEASE_VERSION} ok\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  stampMain().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
