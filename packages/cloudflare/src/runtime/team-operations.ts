/** Fixed team commands share Identity's original receipts and installed owner routing. */
import type { CompileArtifact, MutationEnvelope, MutationResult, ResolvedIdentity } from '@canlang/contracts';
import { SYSTEM_TEAM_TOOL_NAMES } from '@canlang/contracts';
import { IdentityError, inviteMemberWithReceipt, normalizeEmail,
  type IdentityStore, type MailPort } from '@canlang/identity';
import { decodeValue, isUserRef } from '@canlang/values';
import { validateOperationId } from '@canlang/interfaces';
import type { TeamOwnerStorageBoundary } from '../worker/assembly.js';
import type { AssembledModules } from './modules.js';
import { AssemblyCorrespondenceError, importVerifiedAssemblyModule,
  verifyAssemblerModuleCapability } from './assembly-verification.js';
import { systemTeamRoles } from './mcp-registry.js';
import { createCanonicalIdentityRemovalSource } from './invoke.js';

interface TeamContext { readonly resolveCaller: () => Promise<ResolvedIdentity> }
interface CallerScope { readonly principal: string; readonly team: string }
interface TeamOptions {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly app: string;
  readonly identities: IdentityStore;
  readonly ownerStorage?: TeamOwnerStorageBoundary;
  readonly now: () => number;
  readonly deploymentBase?: string;
  readonly mail?: MailPort;
  readonly inviteBaseUrl?: string;
}

function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new IdentityError('validation', 'Team command requires closed own data.');
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const member = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || member === undefined || !member.enumerable || !('value' in member) ||
        fields !== undefined && !fields.includes(key)) {
      throw new IdentityError('validation', 'Team command requires closed own data.');
    }
    result[key] = member.value;
  }
  if (fields !== undefined && fields.some(key => !Object.hasOwn(result, key))) {
    throw new IdentityError('validation', 'Team command inputs are incomplete.');
  }
  return result;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new IdentityError('validation', 'Team command requires nonempty text.');
  return value;
}
function own(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw new AssemblyCorrespondenceError('Team command source is unavailable.');
  const member = Object.getOwnPropertyDescriptor(value, key);
  if (member === undefined || !('value' in member)) throw new AssemblyCorrespondenceError('Team command source is unavailable.');
  return member.value;
}
function sourceOperation(definition: unknown, name: string): unknown {
  const operations = own(definition, 'operations');
  if (typeof operations !== 'object' || operations === null) throw new AssemblyCorrespondenceError('Team operations source is unavailable.');
  const member = Object.getOwnPropertyDescriptor(operations, name);
  if (member === undefined) return undefined; // CRUD hooks live in modelPolicies.
  if (!('value' in member)) throw new AssemblyCorrespondenceError('Team operation source must be own data.');
  return member.value;
}
function user(value: unknown): string {
  const wire = record(value, ['id']);
  try {
    const decoded = decodeValue('user', wire);
    if (isUserRef(decoded)) return decoded.id;
  } catch { /* The input's owning error stays a validation refusal. */ }
  throw new IdentityError('validation', 'Team member must be a canonical user reference.', 'member');
}

/** No request credentials survive the command that uses them. Removal sources
 * remain installed until the containing runtime retires, so staged handlers keep
 * their genuine issuer association. */
export async function createSystemTeamInvoker(opts: TeamOptions) {
  const checkedSource = async () => {
    const first = opts.artifact.modules[0];
    if (first === undefined) throw new AssemblyCorrespondenceError('Team commands require their installed app definition.');
    const entryModule = await importVerifiedAssemblyModule(opts.asm, first.path, opts.artifact);
    const definition = own(entryModule, 'appDefinition');
    const declaredRoles = systemTeamRoles(definition, opts.app);
    const roles = new Set(['owner', ...declaredRoles]);
    const roleCensus = JSON.stringify([own(definition, 'runtimeBindingOwners'), declaredRoles]);
    const artifactCensus = JSON.stringify(opts.artifact);
    const handlers: Array<{ module: unknown; definition: unknown; id: string; operation: unknown; event: unknown }> = [];
    let removalHandlers = false;
    for (const callable of opts.artifact.callables) {
      if (callable.kind !== 'handler') continue;
      const module = await importVerifiedAssemblyModule(opts.asm, callable.module, opts.artifact);
      const handlerDefinition = own(module, 'appDefinition');
      const operation = sourceOperation(handlerDefinition, callable.id);
      if (operation === undefined) {
        handlers.push({ module, definition: handlerDefinition, id: callable.id, operation, event: undefined });
        continue;
      }
      if (typeof operation !== 'object' || operation === null) throw new AssemblyCorrespondenceError('Team handler source is unavailable.');
      const event = Object.getOwnPropertyDescriptor(operation, 'event');
      if (event !== undefined && !('value' in event)) throw new AssemblyCorrespondenceError('Team handler source must be own data.');
      if (event?.value === 'teams.member_removed') removalHandlers = true;
      handlers.push({ module, definition: handlerDefinition, id: callable.id, operation, event: event?.value });
    }
    const assertStable = () => {
      if (JSON.stringify(opts.artifact) !== artifactCensus || own(entryModule, 'appDefinition') !== definition ||
          JSON.stringify([own(definition, 'runtimeBindingOwners'), systemTeamRoles(definition, opts.app)]) !== roleCensus) {
        throw new AssemblyCorrespondenceError('Team command source changed during admission.');
      }
      for (const handler of handlers) {
        if (own(handler.module, 'appDefinition') !== handler.definition ||
            sourceOperation(handler.definition, handler.id) !== handler.operation) {
          throw new AssemblyCorrespondenceError('Team handler source changed during admission.');
        }
        const event = handler.operation === undefined ? undefined : Object.getOwnPropertyDescriptor(handler.operation as object, 'event');
        if (event !== undefined && !('value' in event) || event?.value !== handler.event) {
          throw new AssemblyCorrespondenceError('Team handler event census changed during admission.');
        }
      }
    };
    assertStable();
    return { roles, removalHandlers, assertStable };
  };
  type Source = Awaited<ReturnType<typeof createCanonicalIdentityRemovalSource>>;
  interface RemovalEntry { source?: Source; resolver?: TeamContext['resolveCaller']; tail: Promise<void> }
  const removals = new Map<string, RemovalEntry>();
  const currentOwner = async (scope: CallerScope, context: TeamContext) => {
    if (typeof context?.resolveCaller !== 'function') throw new IdentityError('forbidden', 'Current team credentials are required.');
    await verifyAssemblerModuleCapability(opts.asm, opts.artifact);
    const current = await context.resolveCaller();
    const { principal, team } = scope;
    if (current.actor?.user_id !== principal || current.team?.team_id !== team) {
      throw new IdentityError('forbidden', 'Current caller and selected team must match.');
    }
    if (opts.ownerStorage !== undefined) {
      if (opts.ownerStorage.app !== opts.app) throw new AssemblyCorrespondenceError('Team storage differs from its installed app.');
      await opts.ownerStorage.forIdentity(current);
    }
    const membership = await opts.identities.findMembership(team, principal);
    if (membership === null || membership.status !== 'active' || !membership.is_owner) {
      throw new IdentityError('forbidden', 'Only current team owners can manage members.');
    }
    return { principal, team, current };
  };
  return Object.freeze({
    async invoke(envelope: MutationEnvelope, identity: ResolvedIdentity, context?: TeamContext,
      receiptOnly = false): Promise<MutationResult> {
      const captured = record(envelope, ['operation', 'operation_id', 'inputs']);
      const operation = text(captured.operation), operationId = text(captured.operation_id);
      if (!(SYSTEM_TEAM_TOOL_NAMES as readonly string[]).includes(operation)) throw new IdentityError('not_found', 'Unknown team command.');
      if (context === undefined) throw new IdentityError('forbidden', 'Current team credentials are required.');
      const ageError = validateOperationId(operationId, { nowMs: opts.now });
      if (ageError !== null && ageError.message !== 'Expired operation_id.') {
        throw new IdentityError(ageError.code, ageError.message);
      }
      const retainedOnly = receiptOnly || ageError !== null;
      const inputs = record(captured.inputs, operation === 'system.team.invite' ? ['email', 'role'] :
        operation === 'system.team.role' ? ['member', 'role'] : ['member']);
      // Capture nested user identity and caller scope before any host callback
      // can yield and mutate the supplied objects.
      const member = operation === 'system.team.invite' ? '' : user(inputs.member);
      const role = operation === 'system.team.remove' ? '' : text(inputs.role);
      const email = operation === 'system.team.invite' ? normalizeEmail(text(inputs.email)) : '';
      const principal = identity.actor?.user_id, team = identity.team?.team_id;
      if (principal === undefined || team === undefined) throw new IdentityError('forbidden', 'Current caller and selected team are required.');
      const scope: CallerScope = { principal, team };
      await currentOwner(scope, context);
      const { roles, removalHandlers, assertStable } = await checkedSource();
      const namespace = JSON.stringify(['system.team/v1', opts.app, team, principal, operation]);
      const result = (value: unknown, replayed: boolean): MutationResult => ({
        status: replayed ? 'replayed' : 'committed', operation_id: operationId as MutationEnvelope['operation_id'],
        records: [], deliveries: [], result: value,
      });
      const missing = (): never => { throw new IdentityError('validation', ageError?.message ?? 'No retained original team command is available.'); };
      if (operation === 'system.team.invite') {
        if (!roles.has(role)) throw new IdentityError('validation', 'Unknown declared team role.', 'role');
        const original = { namespace, operationId, team_id: team, email, role, invited_by: principal };
        const read = opts.identities.readInvitationMutationReceipt;
        if (typeof read !== 'function') throw new IdentityError('validation', 'Durable invitation receipts are not configured.');
        const saved = await read.call(opts.identities, original);
        await currentOwner(scope, context);
        assertStable();
        if (retainedOnly) {
          if (saved === null) return missing();
          const state = opts.identities.readInvitationMailState;
          if (typeof state !== 'function') throw new IdentityError('validation', 'Durable invitation mail is not configured.');
          const mail = await state.call(opts.identities, original) ?? 'unknown';
          assertStable();
          return result({ invitation_id: saved.invitation.invitation_id, mail }, true);
        }
        if (opts.mail === undefined || opts.inviteBaseUrl === undefined) throw new IdentityError('validation', 'Trusted invitation mail is not configured.');
        return result(await inviteMemberWithReceipt(opts.identities, opts.mail, original,
          { inviteBaseUrl: opts.inviteBaseUrl }), saved !== null);
      }
      if (operation === 'system.team.role') {
        const selected = role.startsWith('-') ? role.slice(1) : role;
        if (!roles.has(selected)) throw new IdentityError('validation', 'Unknown declared team role.', 'role');
        const original = { namespace, operationId, team_id: team, member_user_id: member, role, granted_by: principal };
        const read = opts.identities.readMemberRoleMutationReceipt;
        if (typeof read !== 'function') throw new IdentityError('validation', 'Durable role receipts are not configured.');
        const saved = await read.call(opts.identities, original);
        await currentOwner(scope, context);
        assertStable();
        if (saved !== null) return result(saved.membership, true);
        if (retainedOnly) return missing();
        const change = opts.identities.changeMemberRoleWithReceipt;
        if (typeof change !== 'function') throw new IdentityError('validation', 'Durable role commands are not configured.');
        return result((await change.call(opts.identities, original)).membership, false);
      }
      const original = { namespace, operationId, team_id: team, member_user_id: member, removed_by: principal };
      const read = opts.identities.readMemberRemovalOccurrence;
      if (typeof read !== 'function') throw new IdentityError('validation', 'Durable removal receipts are not configured.');
      const saved = await read.call(opts.identities, original);
      if (retainedOnly && saved === null) return missing();
      await currentOwner(scope, context);
      assertStable();
      if (!removalHandlers) {
        if (saved !== null) return result({ removed: true }, true);
        const remove = opts.identities.removeMemberWithOccurrence;
        if (typeof remove !== 'function') throw new IdentityError('validation', 'Durable removal commands are not configured.');
        await remove.call(opts.identities, original);
        return result({ removed: true }, false);
      }
      if (opts.ownerStorage === undefined) throw new IdentityError('validation', 'Removal handler owner storage is not configured.');
      const key = JSON.stringify(original);
      let entry = removals.get(key);
      if (entry === undefined) { entry = { tail: Promise.resolve() }; removals.set(key, entry); }
      const selectedEntry = entry;
      const run = selectedEntry.tail.then(async () => {
        await currentOwner(scope, context);
        assertStable();
        selectedEntry.resolver = async () => {
          const owner = await currentOwner(scope, context);
          assertStable();
          return owner.current;
        };
        try {
          selectedEntry.source ??= await createCanonicalIdentityRemovalSource({ ...opts,
            ownerStorage: opts.ownerStorage!, scope: { app: opts.app, ownerPackage: opts.app, owner: team },
            binding: { namespace, team, owner: team, adapter: 'installed-system-team-tools/v1' },
            originalRequest: original, resolveCaller: () => {
              if (selectedEntry.resolver === undefined) throw new IdentityError('forbidden', 'Removal command credentials are no longer active.');
              return selectedEntry.resolver();
            } });
          const retained = await read.call(opts.identities, original);
          await currentOwner(scope, context);
          assertStable();
          if (retained !== null) await selectedEntry.source.recover();
          else {
            if (retainedOnly) return missing();
            await selectedEntry.source.issue();
          }
          // Retained recovery may finish the original interrupted Work handoff;
          // it never issues a new Identity removal, event or provider attempt.
          return result({ removed: true }, retained !== null);
        } finally { delete selectedEntry.resolver; }
      });
      selectedEntry.tail = run.then(() => undefined, () => undefined);
      return run;
    },
  });
}
