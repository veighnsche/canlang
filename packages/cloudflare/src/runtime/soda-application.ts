/** One self-hosted workerd actor owns the real Files issuer and its SQLite leaf. */
import type { CompileArtifact, CompatibilityDescriptor, EnvironmentSelection } from '@canlang/contracts';
import { CONTRACTS_VERSION } from '@canlang/contracts';
import type { IdentityStore } from '@canlang/identity';
import { createDurableSqliteFileStore, createSqliteFileBindings } from '@canlang/files/host/durable-sqlite';
import type { DurableFileSqliteStorage } from '@canlang/files/host/durable-sqlite';
import { DEFAULT_FILE_POLICY } from '@canlang/files/upload';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import type { UploadDeps } from '@canlang/interfaces';
import { checkActivationInventory } from '@canlang/state/migration/activate';
import { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import { buildWorkInventory } from '@canlang/work/recovery';
import { createMainHandlers } from '../worker/main.js';
import type { MainHandlers, StagedDeployment } from '../worker/main.js';
import { loadAppInfo, createTeamOwnerStorageBoundary } from '../worker/assembly.js';
import { buildProductionDeps } from './env-assembly.js';
import { createBoundFileHandler, createCanonicalFileBinding } from './bound-files.js';
import { activate } from '../deploy/activate.js';
import { d1FileAuthority, runtimeFileReferenceProducers } from './d1-file-inventory.js';
import { installNativeFileInventory } from './file-inventory.js';

export interface SodaActorState {
  readonly storage: DurableFileSqliteStorage & { setAlarm(time: number): Promise<void> };
  blockConcurrencyWhile<T>(body: () => Promise<T>): Promise<T>;
}

export interface SodaActorDeployment {
  readonly staged: StagedDeployment;
  readonly descriptor: CompatibilityDescriptor;
  readonly environment: EnvironmentSelection;
  readonly capabilities: readonly string[];
  readonly runtimeVersion: string;
}

/** Configured origin and concrete owner always come from trusted target inputs. */
export function createSodaApplicationClass(deployment: SodaActorDeployment): new (state: SodaActorState, env: Record<string, unknown>) => {
  fetch(request: Request): Promise<Response>; alarm(): Promise<void>;
} {
  return class SodaApplication {
    private readonly ready: Promise<MainHandlers>;
    constructor(private readonly state: SodaActorState, private readonly env: Record<string, unknown>) {
      this.ready = state.blockConcurrencyWhile(async () => {
        const deps = await buildProductionDeps(env);
        const { staged, descriptor, environment } = deployment;
        const artifact: CompileArtifact = staged.artifact;
        const app = await loadAppInfo(artifact, staged.modules);
        if (app.appId !== descriptor.identity.appName || artifact.tool_version !== deployment.runtimeVersion) {
          throw new Error('Soda runtime app identity or producer release differs from deployment');
        }
        const identities = deps.identityStore as IdentityStore;
        const selected = deps.stateTeam;
        if (selected === undefined || await identities.findTeamById(selected.owner) === null) {
          throw new Error('Soda requires an explicitly bootstrapped team and separate State D1');
        }
        const physical = createDurableSqliteFileStore(state.storage);
        const initialRouter = createD1OwnerRouter({ resolveBinding: scope => scope.app === app.appId && scope.owner === selected.owner
          ? { app: scope.app, owner: scope.owner, db: selected.db,
              ...(selected.initializeFresh === true ? { initializeFresh: true as const } : {}) } : null });
        const scope = { app: app.appId, owner: selected.owner, ownerPackage: app.appId };
        // Pin the real physical State owner before binding its source inventory
        // to this actor's permanently retained Files allocation.
        await initialRouter.ownerScopedStoragePort(scope);
        const authority = await d1FileAuthority(selected.db, scope, physical.fileStoreId);
        const router = createD1OwnerRouter({ resolveBinding: requested => requested.app === app.appId && requested.owner === selected.owner
          ? { app: requested.app, owner: requested.owner, db: selected.db,
              fileRetirementAuthority: authority, fileReferenceProducers: runtimeFileReferenceProducers } : null });
        const stateStore = await router.ownerScopedStoragePort(scope);
        const original = await import(staged.modules.entryUrl) as { appDefinition: { runtimeBindingOwners?: readonly string[] } };
        for (const ownerPackage of original.appDefinition.runtimeBindingOwners ?? [app.appId]) {
          await installNativeFileInventory({ artifact, asm: staged.modules, scope: { ...scope, ownerPackage },
            store: stateStore, authority, now: Date.now,
            verifyOwner: async () => {
              if (await identities.findTeamById(selected.owner) === null) throw new Error('Soda State owner is unavailable');
            } });
        }
        const ownerStorage = await createTeamOwnerStorageBoundary({ app: app.appId, artifact, asm: staged.modules, identities, router });
        // External provider dispatch is not qualified yet. This reads the actual
        // store and refuses carryover instead of inventing an empty inventory.
        if ((await stateStore.outboxPending()).length !== 0) {
          throw new Error('Soda runtime has pending external work; explicit recovery is required');
        }
        // State's declaration inventory stores an algorithm-qualified digest;
        // the portable descriptor retains the existing raw SHA-256 contract.
        const installed = await stateStore.readInstalledSnapshot(app.appId);
        const expectedDigest = descriptor.identity.artifactDigest;
        if (installed !== null && installed.digest !== expectedDigest && installed.digest !== `sha256:${expectedDigest}`) {
          throw new Error('Soda installed State snapshot differs from the exact compiled artifact');
        }
        const activationDescriptor = installed === null ? descriptor : { ...descriptor,
          identity: { ...descriptor.identity, artifactDigest: installed.digest } };
        const verdict = await activate({ artifact, descriptor: activationDescriptor, environment,
          installed: { contractsVersion: CONTRACTS_VERSION, runtimeVersion: deployment.runtimeVersion,
            knownLanguageVersions: ['1.0'], capabilities: deployment.capabilities, supportsSchedules: true },
          store: stateStore, inventory: { outboxItems: [], handlerContractFor: () => null,
            plan: { migrationId: `soda:${descriptor.identity.artifactDigest}`, invalidates: [] } },
          gates: { buildWorkInventory, checkActivationInventory: (store, plan, inventory) =>
            checkActivationInventory(store, plan as Parameters<typeof checkActivationInventory>[1], inventory) },
        });
        if (!verdict.active) throw new Error(`Soda activation refused: ${JSON.stringify(verdict.reasons)}`);
        const clock = { nowMs: Date.now };
        const retention = { unattachedHorizonMs: 24 * 60 * 60 * 1000, retentionMs: 365 * 24 * 60 * 60 * 1000, retainAttached: true as const };
        const kernel = createFileJourneyKernel(createSqliteFileBindings(physical, {
          clock, intentTtlMs: 60 * 60 * 1000, urlBase: String(env.CAN_DEPLOYMENT_BASE),
          policy: { ...DEFAULT_FILE_POLICY, types: [...DEFAULT_FILE_POLICY.types] },
          fileRetirement: { storage: stateStore, retention },
        }));
        const upload: UploadDeps & { kernel: typeof kernel } = { app, files: { usesFiles: () => true }, kernel, clock,
          identity: { store: identities, clock, verifyBaseUrl: '', recoveryBaseUrl: '', inviteBaseUrl: '',
            sessionMaxAgeSeconds: 3600, mail: { sendMail: async () => { throw new Error('Soda mail provider is not configured'); } } },
          logger: { log: (level, message, fields) => { console.log('[files]', level, message, fields ?? {}); } } };
        const canonical = createCanonicalFileBinding(kernel, retention);
        const files = { usesFiles: true, kernel, canonical, fileStoreId: physical.fileStoreId,
          readOptions: { upload, physicalFiles: physical.files, retention },
          fetch: createBoundFileHandler({ artifact, asm: staged.modules, store: deps.store,
            ownerStorage,
            memberships: identities, identityStore: identities, clock, upload,
            physicalFiles: physical.files, retention }),
        };
        const handlers = createMainHandlers({
          loadStagedDeployment: async () => ({ ...staged, verdict }),
          loadProductionDeps: async () => ({ ...deps, files, ownerStorage }),
        });
        const probe = await handlers.fetch(new Request(new URL('/', String(env.CAN_AUTH_ORIGIN))), env);
        if (probe.status >= 500) throw new Error(`Soda app assembly refused HTTP ${probe.status}`);
        if (descriptor.schedules.length !== 0 || artifact.callables.some(item => item.kind === 'handler')) {
          await state.storage.setAlarm(Date.now() + 1000);
        }
        return handlers;
      });
    }
    async fetch(request: Request): Promise<Response> {
      const handlers = await this.ready;
      const path = new URL(request.url).pathname;
      if (path.startsWith('/__soda_')) {
        if (request.headers.get('x-soda-control') !== this.env.SODA_CONTROL_TOKEN) return new Response(null, { status: 404 });
        if (path === '/__soda_wake') await this.alarm();
        return new Response('ready');
      }
      return handlers.fetch(request, this.env);
    }
    async alarm(): Promise<void> {
      const handlers = await this.ready;
      try {
        const tasks: Promise<unknown>[] = [];
        await handlers.scheduled({ scheduledTime: Date.now(), cron: 'soda-wakeup' }, this.env,
          { waitUntil: task => { tasks.push(task); } });
        await Promise.all(tasks);
      } finally {
        // Durable source scans own due times and replay identity. This alarm
        // supplies wakeups; it never converts source intervals into cron rules.
        await this.state.storage.setAlarm(Date.now() + 1000);
      }
    }
  };
}
