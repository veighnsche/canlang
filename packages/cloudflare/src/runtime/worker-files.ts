/** Actual File workflow composition. The R2 bucket alone never confers File or record authority. */
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { CompileArtifact, FileRetentionPolicy, StoragePort } from '@canlang/contracts';
import type { IdentityStore } from '@canlang/identity';
import type { UploadDeps } from '@canlang/interfaces';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import type { AssembledModules } from './modules.js';
import { importVerifiedAssemblyModule } from './assembly-verification.js';
import { createBoundFileHandler, createCanonicalFileBinding } from './bound-files.js';
import { stableStringify } from '@canlang/state/invocation';
import { createR2FileBindings } from './r2-files.js';
import type { InterimFilesBinding, TeamOwnerStorageBoundary } from '../worker/assembly.js';

export interface WorkerFilesOptions {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly env: Record<string, unknown>;
  readonly store: StoragePort;
  readonly identities: IdentityStore;
  readonly ownerStorage?: TeamOwnerStorageBoundary;
  readonly origin: string;
  readonly retention: FileRetentionPolicy;
  readonly intentTtlMs: number;
  readonly localLoopback?: true;
  readonly clock?: { nowMs(): number };
}
type ImplicitFileBinding = NonNullable<CompileArtifact['runtimeBindings']>[number];

async function loadWorkerFileDefinition(artifact: CompileArtifact, asm: AssembledModules) {
  const entry = artifact.modules[0];
  if (entry === undefined) throw new Error('Files require their original compiled entry.');
  const original = await importVerifiedAssemblyModule(asm, entry.path, artifact);
  const definition = original !== null && typeof original === 'object' ? Object.getOwnPropertyDescriptor(original, 'appDefinition')?.value as Record<string, unknown> | undefined : undefined;
  if (definition === undefined || stableStringify(Object.getOwnPropertyDescriptor(definition, 'runtimeBindings')?.value) !== stableStringify(artifact.runtimeBindings)) throw new Error('Files inventory differs from its original compiled entry.');
  const app = definition === undefined ? undefined : Object.getOwnPropertyDescriptor(definition, 'id')?.value as unknown;
  const owners: unknown = Object.getOwnPropertyDescriptor(definition, 'runtimeBindingOwners')?.value;
  if (typeof app !== 'string' || app === '' || !Array.isArray(owners) || !owners.includes(app) ||
      owners.some(owner => typeof owner !== 'string' || owner === '') || new Set(owners).size !== owners.length) {
    throw new Error('Files require their actual selected app and source owner closure.');
  }
  return { definition, app, owners };
}

function selectWorkerFileBindings(declared: readonly ImplicitFileBinding[], owners: readonly unknown[], app: string) {
  const bindings = declared.filter(binding => owners.includes(binding.owner));
  if (bindings.length === 0) return undefined;
  // Each composed app retains its original implicit declaration. They share the
  // selected app's single physical FILES bucket, as the local planner does.
  if (bindings.some(binding => binding.binding !== 'FILES' || binding.name !== 'FILES') ||
      new Set(bindings.map(binding => binding.owner)).size !== bindings.length) {
    throw new Error('Files require unique compiler-owned implicit declarations.');
  }
  if (bindings.filter(binding => binding.owner === app).length !== 1) throw new Error('Files bucket differs from its selected owning app.');
  return bindings;
}

function verifyWorkerFileOrigin(origin: string, localLoopback: true | undefined): void {
  const configured = new URL(origin);
  if (configured.origin !== origin || configured.username || configured.password || configured.pathname !== '/' || configured.search || configured.hash ||
      !(configured.protocol === 'https:' || localLoopback === true && configured.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname))) throw new Error('Files require their trusted HTTPS or local preview origin.');
}

function loadWorkerFileBucket(env: Record<string, unknown>) {
  const bucket = env['FILES'] as R2Bucket | undefined, db = env['DB'] as D1Database | undefined;
  if (typeof bucket?.get !== 'function' || typeof bucket.put !== 'function' || typeof db?.prepare !== 'function') throw new Error('Files require their real R2 and D1 bindings.');
  return { bucket, db };
}

export async function createWorkerFiles(options: WorkerFilesOptions): Promise<InterimFilesBinding | undefined> {
  const declared = options.artifact.runtimeBindings?.filter(binding => binding.kind === 'r2' && binding.implicit) ?? [];
  if (declared.length === 0) return undefined;
  const { definition, app, owners } = await loadWorkerFileDefinition(options.artifact, options.asm);
  const bindings = selectWorkerFileBindings(declared, owners, app);
  if (bindings === undefined) return undefined;
  verifyWorkerFileOrigin(options.origin, options.localLoopback);
  const { bucket, db } = loadWorkerFileBucket(options.env);
  const clock = options.clock ?? { nowMs: Date.now };
  const host = await createR2FileBindings({ db, bucket, namespace: `${app}/FILES`, clock, urlBase: options.origin,
    intentTtlMs: options.intentTtlMs, ...(options.localLoopback === true ? { allowInsecureLoopback: true as const } : {}) });
  const kernel = createFileJourneyKernel(host);
  const upload: UploadDeps & { kernel: typeof kernel } = {
    app: { appId: app, brand: app, appDefaultLocale: typeof definition?.['appDefaultLocale'] === 'string' ? definition['appDefaultLocale'] : 'en', ownerLabels: new Map() },
    files: { usesFiles: () => true }, kernel, identity: { store: options.identities }, clock,
    logger: { log(level, message) { console.log(`[files] ${level} ${message}`); } },
  };
  const readOptions = { upload, physicalFiles: host.physicalFiles, retention: options.retention };
  const fetch = createBoundFileHandler({ ...readOptions, artifact: options.artifact, asm: options.asm,
    store: options.store,
    memberships: options.identities, identityStore: options.identities, clock,
    ...(options.ownerStorage === undefined ? {} : { ownerStorage: options.ownerStorage }) });
  // One bounded cleanup page on construction. A restart safely revisits retained journal tombstones.
  await host.cleanup({ beforeMs: Math.max(0, clock.nowMs() - options.intentTtlMs), limit: 100 });
  return Object.freeze({ usesFiles: true, kernel, fileStoreId: host.fileStoreId, intentsUrl: `${options.origin}/files/intents`,
    canonical: createCanonicalFileBinding(kernel, options.retention),
    async fetch(request: Request) {
      const response = await fetch(request);
      await host.cleanup({ beforeMs: Math.max(0, clock.nowMs() - options.intentTtlMs), limit: 25 });
      return response;
    }, readOptions });
}
