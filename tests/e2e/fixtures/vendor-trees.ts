/**
 * Vendor-tree staging for e2e workerd assemblies (leaf module: node-only
 * imports, unit-testable without dists). `readVendorTree` reads one built
 * dist tree into staged modules; `skip` names exact dist-relative posix
 * paths to exclude — test-only bridges (lane-B `fanout/work-loader.js` +
 * `receipt/work-loader.js` carry `node:` imports that trip the workerd
 * link check) must never enter the module set even when a walked dist
 * contains them. Unmatched skip keys fail loud (a renamed bridge is a
 * maintenance signal, not a silent pass); workerd behavior itself is
 * proven by live runs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function readVendorTree(
  root: string,
  distSubdir: string,
  prefix: string,
  buildCommand: string,
  skip: readonly string[] = [],
): Record<string, string> {
  const base = join(root, distSubdir);
  try {
    if (!statSync(base).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`e2e loader: ${distSubdir} not built; run \`${buildCommand}\` first`);
  }
  const modules: Record<string, string> = {};
  const skipped = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".js")) continue;
      const relativePosix = relative(base, full).split(sep).join("/");
      if (skip.includes(relativePosix)) {
        skipped.add(relativePosix);
        continue;
      }
      modules[`${prefix}/${relativePosix}`] = readFileSync(full, "utf8");
    }
  };
  walk(base);
  const unmatched = skip.filter((key) => !skipped.has(key));
  if (unmatched.length > 0) {
    throw new Error(
      `e2e loader: vendor skip keys matched nothing under ${distSubdir}: ${unmatched.join(", ")}`,
    );
  }
  if (Object.keys(modules).length === 0) {
    throw new Error(`e2e loader: no .js modules found under ${distSubdir}; run \`${buildCommand}\``);
  }
  return modules;
}
