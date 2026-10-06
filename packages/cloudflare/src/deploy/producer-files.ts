import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);

/** Resolve an owning package's exported build artifact, including installed packages. */
export function resolveProducerFile(specifier: string, buildCommand: string): string {
  let file: string;
  try {
    // Honor ESM import conditions. Vitest's source transform omits resolve;
    // its fallback uses our packages' shared default entries.
    file = typeof import.meta.resolve === "function"
      ? fileURLToPath(import.meta.resolve(specifier))
      : require.resolve(specifier);
    if (!statSync(file).isFile()) throw new Error("not a file");
  } catch (cause) {
    throw new Error(`deploy bundle: ${specifier} not built; run \`${buildCommand}\` first`, { cause });
  }
  return file;
}
