/**
 * Node-free consumer of assembler-issued module capabilities.
 * Portable URL maps alone carry no capability. The generated owning host
 * binds its installed literal import graph separately from request metadata.
 */
import type { CompileArtifact } from "@canlang/contracts";
import type { AssembledModules } from "./modules.js";

/** Private infrastructure failure: never convert correspondence drift to a business receipt. */
export class AssemblyCorrespondenceError extends Error {
  // Transport renders infrastructure admission refusal as validation. This
  // remains distinct from StateError, so State cannot save a business receipt.
  readonly code = 'validation' as const;
  constructor(message: string) { super(message); this.name = 'AssemblyCorrespondenceError'; }
}

interface AssemblyCapability {
  artifactJson: string;
  ownedArtifact?: CompileArtifact;
  urls: ReadonlyMap<string, string>;
  verifyClosure: () => Promise<void>;
  importModule?: (path: string) => Promise<unknown>;
}

const capabilities = new WeakMap<AssembledModules, AssemblyCapability>();

/** Internal issuer presence only; it neither registers nor grants a capability. */
export function hasAssemblerModuleCapability(asm: AssembledModules): boolean {
  return capabilities.has(asm);
}

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

/** Compiler artifacts are JSON data. Inspect descriptors without executing
 * accessors or toJSON. Optional own undefined keeps the original caller path
 * rather than silently dropping a key that a later closed DTO check needs. */
export function assemblerArtifactDataEligible(root: CompileArtifact): boolean {
  const active = new WeakSet<object>(), seen = new WeakSet<object>();
  const pending: { value: unknown; exit?: boolean }[] = [{ value: root }];
  let eligible = true;
  const refuse = (): never => { throw new AssemblyCorrespondenceError('Assembler artifact requires own JSON data.'); };
  while (pending.length !== 0) {
    const { value, exit } = pending.pop()!;
    if (value === undefined) { eligible = false; continue; }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') { if (!Number.isFinite(value)) refuse(); continue; }
    if (typeof value !== 'object') refuse();
    const node = value as object;
    if (exit) { active.delete(node); continue; }
    if (active.has(node)) refuse();
    if (seen.has(node)) continue;
    const array = Array.isArray(node), prototype = Object.getPrototypeOf(node);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) refuse();
    const descriptors = Object.getOwnPropertyDescriptors(node), keys = Reflect.ownKeys(node);
    if (array) {
      const length = descriptors['length']?.value;
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) refuse();
      for (let index = 0; index < length; index++) if (!Object.hasOwn(descriptors, String(index))) refuse();
    }
    active.add(node); seen.add(node); pending.push({ value: node, exit: true });
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return refuse();
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return refuse();
      pending.push({ value: descriptor.value });
    }
  }
  return eligible;
}

// JSON.parse supplies only own data. The private snapshot retains its exact
// ordinary record/array shape; do not add marker properties to source DTOs.
function frozenArtifact(json: string): CompileArtifact {
  const artifact: CompileArtifact = JSON.parse(json);
  const pending: unknown[] = [artifact];
  while (pending.length !== 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null) continue;
    for (const member of Object.values(value)) pending.push(member);
    Object.freeze(value);
  }
  return artifact;
}

// A changed inherited toJSON can affect even frozen own data. Preserve the
// ordinary comparison path if the shared JSON prototypes have changed.
function plainJsonPrototypes(): boolean {
  return Object.getPrototypeOf(Object.prototype) === null &&
    Object.getPrototypeOf(Array.prototype) === Object.prototype &&
    Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON') === undefined &&
    Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON') === undefined;
}

/** Issue owned JSON data through the existing assembler capability. Optional
 * own undefined keeps the original comparison path, without dropping keys.
 * Caller objects, including deeply frozen copies, never gain issued identity. */
export async function captureVerifiedAssemblerArtifact(
  asm: AssembledModules, expectedArtifact: CompileArtifact,
): Promise<CompileArtifact> {
  const capability = capabilities.get(asm);
  if (capability === undefined) throw new AssemblyCorrespondenceError("importVerifiedAssemblyModule: assembly is not assembler-owned");
  const eligible = assemblerArtifactDataEligible(expectedArtifact) && plainJsonPrototypes();
  await verify(capability, expectedArtifact);
  if (!eligible || !assemblerArtifactDataEligible(expectedArtifact) || !plainJsonPrototypes()) return expectedArtifact;
  const owned = capability.ownedArtifact ??= frozenArtifact(capability.artifactJson);
  // Parsing/freezing is synchronous; validate the original caller again before
  // publishing the owned data, including changes across the file checks.
  await verify(capability, expectedArtifact);
  return assemblerArtifactDataEligible(expectedArtifact) && plainJsonPrototypes() ? owned : expectedArtifact;
}

async function verify(capability: AssemblyCapability, expectedArtifact?: CompileArtifact): Promise<void> {
  const matchesArtifact = () => {
    if (expectedArtifact !== undefined &&
        !(expectedArtifact === capability.ownedArtifact && plainJsonPrototypes()) &&
        JSON.stringify(expectedArtifact) !== capability.artifactJson) {
      throw new AssemblyCorrespondenceError("importVerifiedAssemblyModule: artifact differs from assembled source");
    }
  };
  try {
    matchesArtifact();
    await capability.verifyClosure();
    matchesArtifact();
  } catch (error) {
    if (error instanceof AssemblyCorrespondenceError) throw error;
    throw new AssemblyCorrespondenceError(error instanceof Error ? error.message : String(error));
  }
}

/** Verify the existing issuer and complete captured closure without running a module. */
export async function verifyAssemblerModuleCapability(
  asm: AssembledModules, expectedArtifact: CompileArtifact,
): Promise<void> {
  const capability = capabilities.get(asm);
  if (capability === undefined) throw new AssemblyCorrespondenceError("importVerifiedAssemblyModule: assembly is not assembler-owned");
  await verify(capability, expectedArtifact);
}

/** Import only an assembler-owned, unchanged staged module and its checked closure. */
export async function importVerifiedAssemblyModule(
  asm: AssembledModules, path: string, expectedArtifact?: CompileArtifact,
): Promise<unknown> {
  const capability = capabilities.get(asm);
  if (capability === undefined) throw new AssemblyCorrespondenceError("importVerifiedAssemblyModule: assembly is not assembler-owned");
  const url = capability.urls.get(path);
  if (url === undefined) throw new AssemblyCorrespondenceError("importVerifiedAssemblyModule: unknown artifact module path");
  await verify(capability, expectedArtifact);
  try {
    const imported: unknown = capability.importModule === undefined
      ? await import(url) : await capability.importModule(path);
    return imported;
  } finally {
    await verify(capability, expectedArtifact);
  }
}
