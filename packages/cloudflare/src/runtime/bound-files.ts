import type { CompileArtifact, ResolvedIdentity, StoragePort } from '@canlang/contracts';
import type { IdentityStore } from '@canlang/identity';
import { assertAudience, IdentityError, resolveIdentity } from '@canlang/identity';
import {
  buildBusinessError, fromUnknown, handleUploadRequest, jsonErrorResponse,
  receiverFromIdentity, resolveRequestIdentity, toHttpResponse,
} from '@canlang/interfaces';
import type { UploadDeps } from '@canlang/interfaces';
import type { FileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import { decodeValue } from '@canlang/values';
import type { AssembledModules } from './modules.js';
import { invokeReadCanonical } from './invoke.js';
import type { CanonicalMembershipReader } from './invoke.js';
import type { CanonicalFileBinding } from './file-staging.js';
export type { CanonicalFileBinding } from './file-staging.js';

export function createCanonicalFileBinding(kernel: FileJourneyKernel): CanonicalFileBinding {
  return {
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
}

export interface BoundFileHandlerOpts {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly store: StoragePort;
  readonly memberships: CanonicalMembershipReader;
  readonly identityStore: IdentityStore;
  readonly clock: { nowMs(): number };
  readonly upload: UploadDeps & { readonly kernel: FileJourneyKernel };
}

function notFound(): Response {
  return jsonErrorResponse(buildBusinessError('not_found'), 404);
}

/** Native host join; upload routing/authentication remains owned by Interfaces. */
export function createBoundFileHandler(opts: BoundFileHandlerOpts): (request: Request) => Promise<Response> {
  if (opts.upload.identity.store !== opts.identityStore || opts.upload.clock !== opts.clock) {
    throw new Error('File upload and download must share the identity store and clock.');
  }
  return async request => {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith('/files/read/')) return handleUploadRequest(opts.upload, request);
    if (request.method !== 'GET' || !opts.upload.files.usesFiles(opts.upload.app)) return notFound();
    const parts = pathname.slice('/files/read/'.length).split('/');
    if (parts.length !== 3 || parts.some(part => part === '')) return notFound();
    let model: string, id: string, field: string;
    try { [model, id, field] = parts.map(decodeURIComponent) as [string, string, string]; }
    catch { return notFound(); }
    const declaration = opts.artifact.models?.find(candidate => candidate.name === model);
    const selected = declaration?.fields.find(candidate => candidate.name === field);
    if (selected?.field.kind !== 'file' || selected.array !== undefined) return notFound();
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
      const result = await invokeReadCanonical({
        artifact: opts.artifact, asm: opts.asm, store: opts.store, memberships: opts.memberships,
        identity, operation: `${model}.read`, inputs: {},
        selection: { where: { op: 'eq', field: 'id', value: id }, limit: 1 },
      });
      if (!('records' in result)) throw new Error('File model read returned no records.');
      const row = result.records.find(candidate => candidate.id === id);
      if (row === undefined || !Object.hasOwn(row.data, field) || row.data[field] === null) return null;
      const value = decodeValue('file', row.data[field]) as { id: string };
      return { id: value.id, revision: result.revision, version: row.version };
    };
    try {
      const identity = await resolveCaller();
      const first = await authorized(identity);
      if (first === null) return notFound();
      const receiver = receiverFromIdentity(opts.upload.app.appId, identity);
      const metadata = await opts.upload.kernel.readProvenance(first.id, receiver);
      const bytes = await opts.upload.kernel.readBytes(first.id, receiver);
      if (metadata?.id !== first.id || bytes === null || bytes.byteLength !== metadata.sizeBytes) return notFound();
      // Bytes cross the response boundary only after current credentials and grants
      // are checked again; a changed model revision cannot authorize the old file.
      const latest = await authorized(await resolveCaller());
      if (latest === null || latest.id !== first.id || latest.version !== first.version ||
          latest.revision !== first.revision) return notFound();
      return new Response(new Uint8Array(bytes), { headers: {
        'content-type': metadata.contentType, 'content-length': String(bytes.byteLength),
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': 'attachment',
      } });
    } catch (error) {
      const business = fromUnknown(error);
      const { status, body } = toHttpResponse(business);
      return jsonErrorResponse(body, error instanceof IdentityError ? 401 : status);
    }
  };
}
