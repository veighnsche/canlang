/** Route only after the ordinary HTTP/MCP owner decoded and admitted its envelope. */
import type { CompileArtifact, MutationEnvelope, ReadEnvelope, ResolvedIdentity } from '@canlang/contracts';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1IdentityStore, parseSessionCookie, resolveIdentity, assertAudience, IdentityError } from '@canlang/identity';
import { StateError } from '@canlang/state/errors';
import { parseBoundFileReadRequest } from './bound-files.js';
import type { MutationOutcome, ReadOutcome } from '../worker/assembly.js';
import { resolveRootAuthority, invocationUsesRoot, rootExecutionForEnv, rootInvocationRequest, modelUsesRoot, rootAuthorityForRecord, rootFileRequest, type RootIdentity, type RootInvocation, type RootScope } from './root-authority.js';
import { browseRootAuthorities, createD1RootDirectory } from './root-authority-directory.js';

export interface RootOperationBoundary {
  mutation(envelope: MutationEnvelope, identity: ResolvedIdentity): Promise<MutationOutcome | null>;
  read(envelope: ReadEnvelope, identity: ResolvedIdentity): Promise<ReadOutcome | null>;
  complete(outcome: MutationOutcome | ReadOutcome): void;
}
export function rootIdentity(app: string, identity: ResolvedIdentity): RootIdentity {
  if (identity.actor === null || identity.team === null || identity.membership?.status !== 'active' ||
      identity.membership.user_id !== identity.actor.user_id || identity.membership.team_id !== identity.team.team_id) {
    throw new StateError('forbidden', 'A current authenticated team membership is required for root storage.');
  }
  return { app, owner: identity.team.team_id, principal: identity.actor.user_id };
}

/** Actor admission independently re-resolves the original cookie/grant against real Identity D1. */
export async function authenticateRootRequest(request: Request, env: Record<string, unknown>, app: string): Promise<RootIdentity> {
  const store = createD1IdentityStore(env.DB as D1Database);
  const bearer = /^Bearer\s+([^\s]+)$/i.exec(request.headers.get('authorization') ?? '');
  const token = bearer?.[1] ?? null;
  const session = parseSessionCookie(request.headers.get('cookie') ?? undefined);
  const identity = token === null ? await resolveIdentity(store, session === null ? {} : { session_token: session })
    : await resolveIdentity(store, { mcp_grant_token: token });
  assertAudience(identity.binding, token === null ? 'browser-session' : 'mcp-grant');
  return rootIdentity(app, identity);
}

export function createRootOperationBoundary(options: {
  readonly artifact: CompileArtifact; readonly app: string;
  readonly request: Request; readonly env: Record<string, unknown>;
}): RootOperationBoundary {
  const execution = rootExecutionForEnv(options.env);
  const call = async (envelope: RootInvocation, scope: Pick<RootScope, 'binding' | 'rootId'>): Promise<MutationOutcome | ReadOutcome> => {
    const namespace = options.env[scope.binding] as { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } | undefined;
    if (namespace === undefined || typeof namespace.get !== 'function') throw new StateError('rule_failed', 'The declared root authority is unavailable.');
    const response = await namespace.get(namespace.idFromName(scope.rootId)).fetch(await rootInvocationRequest(options.request, envelope, scope));
    if (response.headers.get('x-can-root-outcome') !== 'v1') throw new StateError(response.status === 401 || response.status === 403 ? 'forbidden' : 'rule_failed', 'The root owner could not independently admit the original request.');
    const outcome: unknown = await response.json();
    if (typeof outcome !== 'object' || outcome === null || (!('result' in outcome) && !('error' in outcome))) throw new StateError('rule_failed', 'Invalid root owner outcome.');
    return outcome as MutationOutcome | ReadOutcome;
  };
  const route = async (envelope: RootInvocation, identity: ResolvedIdentity): Promise<ReturnType<typeof resolveRootAuthority> extends Promise<infer Value> ? Value : never> => {
    // Non-root operations retain their existing anonymous/public behavior.
    const rooted = invocationUsesRoot(options.artifact, envelope);
    if (!rooted) return null;
    if (execution !== undefined) {
      await execution.assertInvocation(envelope, rootIdentity(options.app, identity));
      return null;
    }
    return resolveRootAuthority(options.artifact, envelope, rootIdentity(options.app, identity));
  };
  return {
    async mutation(envelope, identity) {
      const selected = await route(envelope, identity);
      if (selected === null) return null;
      if ('browse' in selected) throw new StateError('rule_failed', 'A mutation requires one directly selected root.');
      return await call(envelope, selected) as MutationOutcome;
    },
    async read(envelope, identity) {
      const selected = await route(envelope, identity);
      if (selected === null) return null;
      if (!('browse' in selected)) return await call(envelope, selected) as ReadOutcome;
      // Generated collection reads have an existing records result. Arbitrary
      // source result expressions cannot be silently aggregated across owners.
      if (!(options.artifact.models ?? []).some(model => envelope.operation === `${model.name}.read`)) throw new StateError('rule_failed', 'This source read requires a concrete root reference.');
      const after = options.request.headers.get('x-can-root-after');
      const page = await browseRootAuthorities({ directory: createD1RootDirectory(options.env.DB as D1Database), scope: selected,
        page: { limit: 100, ...(after === null ? {} : { after }) },
        loadAuthorizedRoot: async entry => {
          const outcome = await call(envelope, entry) as ReadOutcome;
          if ('error' in outcome) {
            if (outcome.error.code === 'not_found' || outcome.error.code === 'forbidden') return null;
            throw new StateError(outcome.error.code, outcome.error.message);
          }
          if (typeof outcome.result !== 'object' || outcome.result === null || !('records' in outcome.result) || !Array.isArray(outcome.result.records)) throw new StateError('rule_failed', 'Root collection read lost its owning records result.');
          return { rootId: entry.rootId, records: outcome.result.records };
        } });
      const records = page.values.flatMap(value => value.records);
      if (records.length > 1000) throw new StateError('limit', 'Root discovery exceeds the bounded current owner read window.');
      return { result: { records, consistency: 'eventual', continuation: page.after } };
    },
    complete(outcome) { execution?.captureOutcome(outcome); },
  };
}

/** The owning File parser and complete original request are repeated inside the actor. */
export async function routeRootFileRequest(options: {
  readonly artifact: CompileArtifact; readonly app: string; readonly request: Request; readonly env: Record<string, unknown>;
}): Promise<Response | null> {
  const parsed = parseBoundFileReadRequest(options.request);
  if (parsed === null || !modelUsesRoot(options.artifact, parsed.locator.model)) return null;
  try {
    const authenticated = await authenticateRootRequest(options.request, options.env, options.app);
    const scope = rootAuthorityForRecord(options.artifact, parsed.locator.model, parsed.locator.recordId, authenticated);
    if (scope === null) return null;
    const execution = rootExecutionForEnv(options.env);
    if (execution !== undefined) { await execution.assertFileRequest(parsed, authenticated); return null; }
    const namespace = options.env[scope.binding] as { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } | undefined;
    if (namespace === undefined) throw new Error('The protected File root namespace is unavailable.');
    const response = await namespace.get(namespace.idFromName(scope.rootId)).fetch(await rootFileRequest(options.request, parsed, scope));
    // A different team/root reveals no protected File or record existence.
    return response;
  } catch (error) {
    if (error instanceof StateError && ['forbidden', 'rule_failed', 'not_found'].includes(error.code)) return new Response(null, { status: 404 });
    if (error instanceof IdentityError) return Response.json({ code: error.code, message: error.message }, { status: 401 });
    throw error;
  }
}
