/**
 * Node-free consumer of assembler-issued module capabilities.
 * Portable URL maps alone carry no capability. The generated owning host
 * binds its installed literal import graph separately from request metadata.
 */
import type { CompileArtifact } from "@canlang/contracts";
import type { AssembledModules } from "./modules.js";

interface AssemblyCapability {
  artifactJson: string;
  urls: ReadonlyMap<string, string>;
  verifyClosure: () => Promise<void>;
  importModule?: (path: string) => Promise<unknown>;
}

const capabilities = new WeakMap<AssembledModules, AssemblyCapability>();

/**
 * Internal trusted-host registration. The Node assembler supplies filesystem
 * verification; the generated portable host supplies its captured literal
 * importer and immutable installed-graph checks. This is not a runtime option,
 * artifact declaration, package public export, or request-level capability.
 */
export function registerAssemblerModuleCapability(
  asm: AssembledModules,
  artifactJson: string,
  modules: readonly { path: string; url: string }[],
  verifyClosure: () => Promise<void>,
  importModule?: (path: string) => Promise<unknown>,
): void {
  if (capabilities.has(asm)) throw new Error("assembly capability already registered");
  if (importModule !== undefined && typeof importModule !== "function") throw new Error("assembly capability lacks a captured importer");
  capabilities.set(asm, { artifactJson, urls: new Map(modules.map(module => [module.path, module.url])), verifyClosure,
    ...(importModule === undefined ? {} : { importModule }) });
}

async function verify(capability: AssemblyCapability, expectedArtifact?: CompileArtifact): Promise<void> {
  const matchesArtifact = () => {
    if (expectedArtifact !== undefined && JSON.stringify(expectedArtifact) !== capability.artifactJson) {
      throw new Error("importVerifiedAssemblyModule: artifact differs from assembled source");
    }
  };
  matchesArtifact();
  await capability.verifyClosure();
  matchesArtifact();
}

/** Import only an assembler-owned, unchanged staged module and its checked closure. */
export async function importVerifiedAssemblyModule(
  asm: AssembledModules, path: string, expectedArtifact?: CompileArtifact,
): Promise<unknown> {
  const capability = capabilities.get(asm);
  if (capability === undefined) throw new Error("importVerifiedAssemblyModule: assembly is not assembler-owned");
  const url = capability.urls.get(path);
  if (url === undefined) throw new Error("importVerifiedAssemblyModule: unknown artifact module path");
  await verify(capability, expectedArtifact);
  try {
    const imported: unknown = capability.importModule === undefined
      ? await import(url) : await capability.importModule(path);
    return imported;
  } finally {
    await verify(capability, expectedArtifact);
  }
}
