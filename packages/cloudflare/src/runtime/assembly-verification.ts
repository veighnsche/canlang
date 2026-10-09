/**
 * Node-free consumer of assembler-issued module capabilities.
 * Portable URL maps carry no capability and cannot qualify native policies.
 */
import type { CompileArtifact } from "@canlang/contracts";
import type { AssembledModules } from "./modules.js";

interface AssemblyCapability {
  artifactJson: string;
  urls: ReadonlyMap<string, string>;
  verifyClosure: () => Promise<void>;
}

const capabilities = new WeakMap<AssembledModules, AssemblyCapability>();

/**
 * Internal trusted-host registration, called only by the Node assembler after
 * its initial filesystem verification. This is not a runtime option, artifact
 * declaration, package public export, or portable assembly producer.
 */
export function registerAssemblerModuleCapability(
  asm: AssembledModules,
  artifactJson: string,
  modules: readonly { path: string; url: string }[],
  verifyClosure: () => Promise<void>,
): void {
  if (capabilities.has(asm)) throw new Error("assembly capability already registered");
  capabilities.set(asm, { artifactJson, urls: new Map(modules.map(module => [module.path, module.url])), verifyClosure });
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
    const imported: unknown = await import(url);
    return imported;
  } finally {
    await verify(capability, expectedArtifact);
  }
}
