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
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function readVendorTree(
  directory: string | URL,
  prefix: string,
  buildCommand: string,
  skip: readonly string[] = [],
): Record<string, string> {
  const base = typeof directory === "string" ? directory : fileURLToPath(directory);
  try {
    if (!statSync(base).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`e2e loader: ${base} not built; run \`${buildCommand}\` first`);
  }
  const modules: Record<string, string> = {};
  const skipped = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".js") || entry.endsWith(".test.js") || entry === "distribution.js") continue;
      const relativePosix = relative(base, full).split(sep).join("/");
      if (skip.includes(relativePosix)) {
        skipped.add(relativePosix);
        continue;
      }
      const key = `${prefix}/${relativePosix}`;
      modules[key] = rewriteVendorImports(readFileSync(full, "utf8"), key);
    }
  };
  walk(base);
  const unmatched = skip.filter((key) => !skipped.has(key));
  if (unmatched.length > 0) {
    throw new Error(
      `e2e loader: vendor skip keys matched nothing under ${base}: ${unmatched.join(", ")}`,
    );
  }
  if (Object.keys(modules).length === 0) {
    throw new Error(`e2e loader: no .js modules found under ${base}; run \`${buildCommand}\``);
  }
  return modules;
}

/** Rewrite the declared contract dependency to the portable module-map entry. */
function rewriteVendorImports(js: string, moduleKey: string): string {
  const target = posix.relative(posix.dirname(moduleKey), "vendor/contracts/index.js");
  const contracts = target.startsWith(".") ? target : `./${target}`;
  const replace = (_match: string, before: string, specifier: string, after: string): string =>
    `${before}${specifier === "@canlang/contracts" ? contracts : specifier}${after}`;
  return js
    .replace(/(\bfrom\s*["'])([^"']+)(["'])/g, replace)
    .replace(/(\bimport\s*\(\s*["'])([^"']+)(["']\s*\))/g, replace)
    .replace(/(\bimport\s*["'])([^"']+)(["'])/g, replace);
}
