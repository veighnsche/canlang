import type { CompileArtifact, FileRetentionPolicy, RetainedFinalizedFile, ModelName, RecordId, ResolvedIdentity, StoragePort } from '@canlang/contracts';
import type { FinalizedStorePort, StoredFileRecord } from '@canlang/files/ports';
import { readFinalizedFileObservation } from '@canlang/files/finalize';
import { createFileReferenceConsumer, StateError } from '@canlang/state';
import { stableStringify } from '@canlang/state/invocation';
import type { IdentityStore } from '@canlang/identity';
import { assertAudience, IdentityError, resolveIdentity } from '@canlang/identity';
import {
  buildBusinessError, fromUnknown, handleUploadRequest, jsonErrorResponse,
  receiverFromIdentity, resolveRequestIdentity, toHttpResponse,
} from '@canlang/interfaces';
import type { UploadDeps } from '@canlang/interfaces';
import type { FileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import { decodeValue, encodeValue } from '@canlang/values';
import type { AssembledModules } from './modules.js';
import { invokeReadCanonical, loadCanonicalDescriptors } from './invoke.js';
import type { CanonicalMembershipReader } from './invoke.js';
import type { CanonicalFileBinding } from './file-staging.js';
import { registerRetainedCanonicalFileObserver } from './file-staging.js';
import type { TeamOwnerStorageBoundary } from '../worker/assembly.js';
import { AssemblyCorrespondenceError, hasAssemblerModuleCapability, verifyAssemblerModuleCapability } from './assembly-verification.js';
export type { CanonicalFileBinding } from './file-staging.js';

export function createCanonicalFileBinding(kernel: FileJourneyKernel, retention?: FileRetentionPolicy): CanonicalFileBinding {
  // Legacy attachment callers need no saved File capture. A saved observation
  // always requires the host's explicit receiving policy, pinned at construction.
  const policy = retention === undefined ? undefined : Object.freeze({
    unattachedHorizonMs: retention.unattachedHorizonMs,
    retentionMs: retention.retentionMs,
  });
  const files: CanonicalFileBinding = {
    async observe(ref, identity, app) {
      if (policy === undefined || identity.actor === null) return null;
      return kernel.observeFile(ref, receiverFromIdentity(app, identity), policy);
    },
    async revalidate(saved, receiver) {
      if (policy === undefined) return false;
      return kernel.revalidateFile(saved, receiver, policy);
    },
    async validate(ref, identity, app) {
      if (identity.actor === null) return false;
      const receiver = receiverFromIdentity(app, identity);
      const decision = await kernel.authorizeAttach(ref, receiver);
      if (decision.status !== 'authorized' || decision.ref !== ref) return false;
      const metadata = await kernel.readProvenance(ref, receiver);
      const bytes = await kernel.readBytes(ref, receiver);
      return metadata?.id === ref && bytes !== null && bytes.byteLength === metadata.sizeBytes;
    },
    async retain(ref, record, identity, app) {
      try {
        const result = await kernel.recordAttachment(ref, record, receiverFromIdentity(app, identity));
        if (result.status === 'attached' && result.ref === ref) return;
      } catch {
        // The domain receipt is already durable. Expose a safe retriable host
        // failure, preserving replay repair without disclosing storage detail.
      }
      throw new Error('Committed file attachment requires retry.');
    },
  };
  const observe = kernel.observeFile, revalidate = kernel.revalidateFile;
  registerRetainedCanonicalFileObserver(files, async (saved, verifySource) => {
    // This callback is private host composition. The caller verifies the actual
    // retained source before the original receiver crosses any kernel seam.
    if (policy === undefined || stableStringify(saved.retention) !== stableStringify(policy)) return null;
    const receiver = Object.freeze({ ...saved.receiver });
    const current = async (): Promise<void> => {
      await verifySource();
      if (kernel.observeFile !== observe || kernel.revalidateFile !== revalidate) {
        throw new Error('Retained File receiving kernel changed.');
      }
    };
    await current();
    if (!await revalidate.call(kernel, saved, receiver, policy)) return null;
    await current();
    const observation = await observe.call(kernel, saved.ref, receiver, policy);
    await current();
    if (observation === null || stableStringify(readFinalizedFileObservation(observation)) !== stableStringify(saved)) return null;
    if (!await revalidate.call(kernel, saved, receiver, policy)) return null;
    await current();
    return observation;
  });
  return files;
}

export interface BoundFileHandlerOpts {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly store: StoragePort;
  /** Select the same actual team owner used by canonical operation admission. */
  readonly ownerStorage?: TeamOwnerStorageBoundary;
  readonly memberships: CanonicalMembershipReader;
  readonly identityStore: IdentityStore;
  readonly clock: { nowMs(): number };
  readonly upload: UploadDeps & { readonly kernel: FileJourneyKernel };
  /** Genuine receiving store; saved receiver facts convey no disclosure grant. */
  readonly physicalFiles: Pick<FinalizedStorePort, 'get'>;
  readonly retention: FileRetentionPolicy;
  readonly fileReferenceBounds?: { readonly maxRows: number; readonly maxReferences: number };
}

function notFound(): Response {
  return jsonErrorResponse(buildBusinessError('not_found'), 404);
}

function physicalCheckpoint(record: StoredFileRecord): string {
  return JSON.stringify({ ...record, file: {
    ...record.file, finalizedAt: encodeValue('datetime', record.file.finalizedAt),
  } });
}

/** Native host join; upload routing/authentication remains owned by Interfaces. */
export function createBoundFileHandler(opts: BoundFileHandlerOpts): (request: Request) => Promise<Response> {
  if (!hasAssemblerModuleCapability(opts.asm)) {
    throw new AssemblyCorrespondenceError('File downloads require the original issued assembly.');
  }
  if (opts.upload.identity.store !== opts.identityStore || opts.upload.clock !== opts.clock) {
    throw new Error('File upload and download must share the identity store and clock.');
  }
  if (opts.ownerStorage !== undefined && opts.ownerStorage.app !== opts.upload.app.appId) {
    throw new Error('File owner storage must belong to the declared app.');
  }
  if (typeof opts.physicalFiles?.get !== 'function' || opts.retention === undefined) {
    throw new Error('File downloads require the receiving store and explicit retention.');
  }
  const retention = Object.freeze({ ...opts.retention });
  const bounds = Object.freeze({ ...(opts.fileReferenceBounds ?? { maxRows: 10_000, maxReferences: 20_000 }) });
  return async request => {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith('/files/read/')) return handleUploadRequest(opts.upload, request);
    if (request.method !== 'GET' || !opts.upload.files.usesFiles(opts.upload.app)) return notFound();
    const parts = pathname.slice('/files/read/'.length).split('/');
    if ((parts.length !== 3 && parts.length !== 4) || parts.some(part => part === '')) return notFound();
    let model: string, id: string, field: string, requestedRef: string | undefined;
    try { [model, id, field, requestedRef] = parts.map(decodeURIComponent) as [string, string, string, string?]; }
    catch { return notFound(); }
    const declaration = opts.artifact.models?.find(candidate => candidate.name === model);
    const selected = declaration?.fields.find(candidate => candidate.name === field);
    if (selected === undefined || requestedRef === undefined &&
        (selected.field.kind !== 'file' || selected.array !== undefined)) return notFound();
    const resolveCaller = async (): Promise<ResolvedIdentity> => {
      const bearer = /^Bearer\s+([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
      if (bearer !== null) {
        const identity = await resolveIdentity(opts.identityStore, { mcp_grant_token: bearer[1]! }, { clock: opts.clock });
        assertAudience(identity.binding, 'mcp-grant');
        return identity;
      }
      const resolved = await resolveRequestIdentity(opts.identityStore, request, { clock: opts.clock });
      if (resolved.sessionToken === null) throw new IdentityError('forbidden', 'Authentication required.');
      assertAudience(resolved.identity.binding, 'browser-session');
      return resolved.identity;
    };
    const authorized = async (identity: ResolvedIdentity) => {
      await verifyAssemblerModuleCapability(opts.asm, opts.artifact);
      const store = opts.ownerStorage === undefined ? opts.store : await opts.ownerStorage.forIdentity(identity);
      const result = await invokeReadCanonical({
        artifact: opts.artifact, asm: opts.asm, store, memberships: opts.memberships,
        identity, operation: `${model}.read`, inputs: {},
        selection: { where: { op: 'eq', field: 'id', value: id }, limit: 1 },
      });
      await verifyAssemblerModuleCapability(opts.asm, opts.artifact);
      if (!('records' in result)) throw new Error('File model read returned no records.');
      const row = result.records.find(candidate => candidate.id === id);
      if (row === undefined || !Object.hasOwn(row.data, field) || row.data[field] === null) return null;
      // An explicit reference selects within the complete current field. State's
      // owning profile proves File membership, including nested/array positions.
      const ref = requestedRef ?? (decodeValue('file', row.data[field]) as { id: string }).id;
      return { id: ref, revision: result.revision, version: row.version, store };
    };
    try {
      const identity = await resolveCaller();
      const first = await authorized(identity);
      if (first === null) return notFound();
      const caller = receiverFromIdentity(opts.upload.app.appId, identity);
      const scope = { app: caller.app, team: caller.team, owner: caller.owner };
      const loaded = await loadCanonicalDescriptors(opts.asm, opts.artifact);
      if (loaded.ruledModels.has(model)) return notFound();
      type ConsumerInput = Parameters<typeof createFileReferenceConsumer>[0];
      const consumer = createFileReferenceConsumer({
        scope, store: first.store, memberships: opts.memberships,
        policy: loaded.policy as ConsumerInput['policy'], registry: loaded.registry as ConsumerInput['registry'],
        canonicalModels: loaded.models, artifactModels: opts.artifact.models!,
        ...(loaded.valueTypes === undefined ? {} : { valueTypes: loaded.valueTypes }), ...bounds,
      });
      const physical: { facts: RetainedFinalizedFile | null; checkpoint: string | null } = { facts: null, checkpoint: null };
      const bytes = await consumer.read({ model: model as ModelName, recordId: id as RecordId, field, ref: first.id }, caller,
        async slot => {
          const stored = opts.physicalFiles.get(slot.ref);
          if (stored?.file.id !== slot.ref || stored.owner.app !== scope.app ||
              stored.owner.team !== scope.team || stored.owner.owner !== scope.owner) return null;
          const checkpoint = physicalCheckpoint(stored);
          // The actual original receiver selects physical bytes. State grants
          // the current reader independently, including another current member.
          const receiver = Object.freeze({ ...stored.owner });
          const snapshot = await opts.upload.kernel.readCurrentSnapshot(slot.ref, receiver, retention);
          if (snapshot === null || snapshot.facts.ref !== slot.ref || snapshot.bytes.byteLength !== snapshot.facts.sizeBytes ||
              (['app', 'team', 'owner', 'principal'] as const).some(key => snapshot.facts.receiver[key] !== receiver[key])) return null;
          // Refuse physical metadata drift across the asynchronous host seam.
          // This checkpoint is neither a cross-store lock nor a deletion fence.
          const latestPhysical = opts.physicalFiles.get(slot.ref);
          if (latestPhysical === null || physicalCheckpoint(latestPhysical) !== checkpoint) return null;
          physical.facts = snapshot.facts;
          physical.checkpoint = checkpoint;
          return snapshot.bytes;
        });
      const metadata = physical.facts;
      if (metadata === null || bytes === null) return notFound();
      // Bytes cross the response boundary only after current credentials and grants
      // are checked again; a changed model revision cannot authorize the old file.
      const latestIdentity = await resolveCaller();
      if (latestIdentity.actor?.user_id !== identity.actor?.user_id ||
          latestIdentity.team?.team_id !== identity.team?.team_id) return notFound();
      const latest = await authorized(latestIdentity);
      if (latest === null || latest.id !== first.id || latest.version !== first.version ||
          latest.revision !== first.revision) return notFound();
      const disclosedPhysical = opts.physicalFiles.get(first.id);
      if (disclosedPhysical === null || physicalCheckpoint(disclosedPhysical) !== physical.checkpoint) return notFound();
      return new Response(new Uint8Array(bytes), { headers: {
        'content-type': metadata.contentType, 'content-length': String(bytes.byteLength),
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': 'attachment',
      } });
    } catch (error) {
      if (error instanceof StateError && (error.code === 'forbidden' || error.code === 'conflict')) return notFound();
      const business = fromUnknown(error);
      const { status, body } = toHttpResponse(business);
      return jsonErrorResponse(body, error instanceof IdentityError ? 401 : status);
    }
  };
}
