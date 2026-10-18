/** One canonical invocation runs beside its authoritative per-root SQLite store. */
import type { DurableObjectState, DurableObjectStorage, DurableObjectNamespace } from '@cloudflare/workers-types';
import type { CommitBatch, CompileArtifact, ReceiptIdentity, StoragePort, FileRetirementAuthority, FileReferenceStoragePort, FrameworkFileReferenceProducer } from '@canlang/contracts';
import { createDOStorage, ensureSchema } from '@canlang/state/storage/durable-object';
import { StateError } from '@canlang/state/errors';
import { IdentityError } from '@canlang/identity';
import { stableStringify } from '@canlang/state/invocation';
import { enqueueRootDirectoryUpdate, projectRootDirectoryUpdates, type RootDirectory } from './root-authority-directory.js';

export const ROOT_AUTHORITY_CLASS = 'CanRootAuthority';
export interface RootInvocation { readonly operation: string; readonly operation_id?: string; readonly inputs: Readonly<Record<string, unknown>> }
export interface RootIdentity { readonly app: string; readonly owner: string; readonly principal: string }
export interface RootScope extends RootIdentity {
  readonly binding: string; readonly model: string; readonly rootId: string; readonly creating: boolean;
}
export interface RootExecution {
  readonly scope: RootScope; readonly identity: RootIdentity; readonly store: StoragePort;
  readonly allocateId: (model: string, index?: number) => string;
  readonly assertInvocation: (invocation: RootInvocation, identity: RootIdentity) => Promise<void>;
  readonly assertFileRequest: (locator: unknown, identity: RootIdentity) => Promise<void>;
  readonly captureOutcome: (outcome: unknown) => void;
}
export interface RootBrowse extends RootIdentity { readonly browse: true; readonly binding: string; readonly model: string }
export type RootRoute = RootScope | RootBrowse;
type RootBinding = { readonly kind: 'durable-object'; readonly owner: string; readonly name: string; readonly binding: string; readonly key: string };
type RootModel = { readonly name: string; readonly parent?: string; readonly at?: string };
const executions = new WeakMap<object, RootExecution>();

/** Only the real actor factory below can mint this private per-request composition. */
export function rootExecutionForEnv(env: object): RootExecution | undefined { return executions.get(env); }
const fail = (message: string): never => { throw new StateError('rule_failed', message); };
const ROOT_ID = /^r1\.([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]{43})\.([0-9a-z]+))?$/;

export function rootIdOfRecord(id: string): string | null {
  if (typeof id !== 'string' || id.length > 200) return null;
  const match = ROOT_ID.exec(id);
  return match === null ? null : `r1.${match[1]}`;
}
function plain(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function identity(input: RootIdentity): RootIdentity {
  if (!input || [input.app, input.owner, input.principal].some(value => typeof value !== 'string' || value === '')) return fail('Root authority requires the fresh authenticated app, team and principal.');
  return Object.freeze({ app: input.app, owner: input.owner, principal: input.principal });
}
function modelsOf(artifact: CompileArtifact): readonly RootModel[] { return artifact.models ?? []; }
function bindingsOf(artifact: CompileArtifact): readonly RootBinding[] {
  const entries = (artifact as unknown as { runtimeBindings?: unknown }).runtimeBindings;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return fail('Root authority requires compiler-owned runtime bindings.');
  return entries.filter(entry => plain(entry) && entry.kind === 'durable-object') as RootBinding[];
}
function ownerForModel(artifact: CompileArtifact, model: string): RootBinding | null {
  const models = new Map(modelsOf(artifact).map(item => [item.name, item]));
  const visiting = new Set<string>();
  let current = models.get(model);
  while (current !== undefined) {
    if (visiting.has(current.name)) return fail('Root model containment is cyclic.');
    visiting.add(current.name);
    const matches = bindingsOf(artifact).filter(binding => binding.key === current!.name);
    if (matches.length !== 0 || current.at !== undefined) {
      if (matches.length !== 1 || current.parent !== undefined || current.at !== undefined && matches[0]!.binding !== current.at) return fail('Root model requires its exact checked root binding.');
      return matches[0]!;
    }
    current = current.parent === undefined ? undefined : models.get(current.parent);
  }
  return null;
}
async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function operationIdentity(invocation: RootInvocation, auth: RootIdentity): readonly string[] {
  if (typeof invocation.operation_id !== 'string' || invocation.operation_id === '') return fail('Root creation requires its complete mutation operation identity.');
  return [auth.app, auth.owner, auth.principal, invocation.operation, invocation.operation_id];
}

/** Root classification uses compiler ownership before requiring a team identity. */
export function invocationUsesRoot(artifact: CompileArtifact, invocation: RootInvocation): boolean {
  const operation = artifact.operations?.find(item => item.name === invocation.operation);
  if (operation === undefined) return false;
  if (operation.rootAuthority !== undefined) return true;
  const direct = modelsOf(artifact).find(model => invocation.operation === `${model.name}.${operation.kind}`);
  return direct !== undefined && ownerForModel(artifact, direct.name) !== null ||
    operation.inputs.fields.some(input => input.field.kind === 'ref' && ownerForModel(artifact, input.field.model) !== null);
}

export function modelUsesRoot(artifact: CompileArtifact, model: string): boolean { return ownerForModel(artifact, model) !== null; }
export function rootAuthorityForRecord(artifact: CompileArtifact, model: string, id: string, authenticated: RootIdentity): RootScope | null {
  const binding = ownerForModel(artifact, model);
  if (binding === null) return null;
  const rootId = rootIdOfRecord(id);
  if (rootId === null) return fail('The record has no direct root identity.');
  return { ...identity(authenticated), binding: binding.binding, model: binding.key, rootId, creating: false };
}

/** Uses checked model/input metadata; a directory lookup never decides authority. */
export async function resolveRootAuthority(artifact: CompileArtifact, invocation: RootInvocation, authenticated: RootIdentity): Promise<RootRoute | null> {
  const auth = identity(authenticated);
  const operation = (artifact.operations ?? []).find(item => item.name === invocation.operation);
  if (operation === undefined) return fail('Root routing requires a declared operation.');
  if (!plain(invocation.inputs)) return fail('Root routing requires canonical named inputs.');
  const direct = modelsOf(artifact).find(model => invocation.operation === `${model.name}.${operation.kind}`);
  const published = (operation as unknown as { rootAuthority?: { binding: string; model: string; createsRoot?: true } }).rootAuthority;
  const target = direct === undefined ? published === undefined ? null : bindingsOf(artifact).find(binding => binding.binding === published.binding && binding.key === published.model) ?? null
    : ownerForModel(artifact, direct.name);
  const { selected, hasDefaultReference } = selectRootReference(operation, invocation, artifact);
  return resolveRootOutcome(auth, direct, operation, published, target, selected, hasDefaultReference, invocation);
}

function selectRootReference(operation: NonNullable<CompileArtifact['operations']>[number], invocation: RootInvocation,
  artifact: CompileArtifact): { selected: { binding: RootBinding; rootId: string } | null; hasDefaultReference: boolean } {
  let selected: { binding: RootBinding; rootId: string } | null = null;
  let hasDefaultReference = false;
  for (const input of operation.inputs.fields) {
    if (input.field.kind !== 'ref' || invocation.inputs[input.name] === undefined || invocation.inputs[input.name] === null) continue;
    const binding = ownerForModel(artifact, input.field.model);
    if (binding === null) { hasDefaultReference = true; continue; }
    for (const reference of input.array === undefined ? [invocation.inputs[input.name]] : invocation.inputs[input.name] as unknown[]) {
      if (!plain(reference) || typeof reference.id !== 'string') return fail('Root routing requires its declared record identity.');
      const rootId = rootIdOfRecord(reference.id);
      if (rootId === null) return fail('Root reference has no direct routing identity.');
      if (selected !== null && (selected.binding.binding !== binding.binding || selected.rootId !== rootId)) return fail('A business invocation cannot cross root authorities.');
      selected = { binding, rootId };
    }
  }
  return { selected, hasDefaultReference };
}

async function resolveRootOutcome(auth: RootIdentity, direct: RootModel | undefined,
  operation: NonNullable<CompileArtifact['operations']>[number],
  published: { binding: string; model: string; createsRoot?: true } | undefined,
  target: RootBinding | null, selected: { binding: RootBinding; rootId: string } | null,
  hasDefaultReference: boolean, invocation: RootInvocation): Promise<RootRoute | null> {
  if (target !== null && selected !== null && target.binding !== selected.binding.binding) return fail('The operation and its references require different root authorities.');
  if ((target !== null || selected !== null) && hasDefaultReference) return fail('Root business decisions cannot read a second D1 authority.');
  if (target !== null && (direct !== undefined && operation.kind === 'create' && direct.name === target.key || published?.createsRoot === true)) {
    if (selected !== null) return fail('A new root cannot depend on another mutable root.');
    const rootId = `r1.${await digest(['can-root/v1', target.binding, target.key, ...operationIdentity(invocation, auth)])}`;
    return Object.freeze({ ...auth, binding: target.binding, model: target.key, rootId, creating: true });
  }
  if (selected !== null) return Object.freeze({ ...auth, binding: selected.binding.binding, model: selected.binding.key, rootId: selected.rootId, creating: false });
  if (target !== null) {
    if (operation.kind === 'read') return Object.freeze({ ...auth, browse: true, binding: target.binding, model: target.key });
    return fail('This operation requires a directly routed root reference.');
  }
  return null;
}

export async function createRootRecordAllocator(artifact: CompileArtifact, scope: RootScope, invocation: RootInvocation): Promise<RootExecution['allocateId']> {
  if (invocation.operation_id === undefined) return () => fail('A read cannot allocate a new business identity.');
  const operationHash = await digest(['can-root-child/v1', ...operationIdentity(invocation, scope)]);
  return (model, index = 0) => {
    if (!Number.isSafeInteger(index) || index < 0 || ownerForModel(artifact, model)?.binding !== scope.binding) return fail('Record creation requires this root authority and its deterministic occurrence index.');
    if (model === scope.model) {
      if (!scope.creating || index !== 0) return fail('One invocation cannot create a second root authority.');
      return scope.rootId;
    }
    return `${scope.rootId}.${operationHash}.${index.toString(36)}`;
  };
}

const guardedD1Ports = new WeakMap<StoragePort, Set<string>>();
/** Preserve the genuine D1 port, while rooted domain models can never use it. */
export function rejectRootModelsInD1<Port extends StoragePort>(store: Port, artifact: CompileArtifact): Port {
  const rooted = modelsOf(artifact).filter(model => modelUsesRoot(artifact, model.name)).map(model => model.name);
  if (rooted.length === 0) return store;
  const previous = guardedD1Ports.get(store);
  if (previous !== undefined) { for (const model of rooted) previous.add(model); return store; }
  const models = new Set(rooted);
  const check = (model: string) => { if (models.has(model)) fail('This rooted model requires its actual Durable Object authority; directory page queries are not installed.'); };
  const load = store.load, query = store.query, commit = store.commit, history = store.historyFor;
  store.load = async (model, id) => { check(model); return load.call(store, model, id); };
  store.query = async input => { check(input.model); return query.call(store, input); };
  store.commit = async batch => { for (const write of batch.writes) check(write.model); return commit.call(store, batch); };
  store.historyFor = async (model, id) => { check(model); return history.call(store, model, id); };
  const cohortLoad = store.cohortLoad, cohortAnchorFact = store.cohortAnchorFact;
  store.cohortLoad = async input => { check(input.model); return cohortLoad.call(store, input); };
  store.cohortAnchorFact = async input => { check(input.model); return cohortAnchorFact.call(store, input); };
  const cohortIdentityPage = store.cohortIdentityPage, cohortRowPage = store.cohortRowPage;
  store.cohortIdentityPage = async input => { check(input.model); return cohortIdentityPage.call(store, input); };
  store.cohortRowPage = async input => { check(input.model); return cohortRowPage.call(store, input); };
  if (store.uniqueOwner !== undefined) { const method = store.uniqueOwner; store.uniqueOwner = async (model, key, value) => { check(model); return method.call(store, model, key, value); }; }
  if (store.historyReadBounded !== undefined) { const method = store.historyReadBounded; store.historyReadBounded = async input => { check(input.model); return method.call(store, input); }; }
  guardedD1Ports.set(store, models);
  return store;
}

/** Keep the constructor-returned port and its private State capability correspondence. */
function guardRootStore(store: StoragePort, artifact: CompileArtifact, scope: RootScope, admitted: () => boolean = () => true, internal = false): StoragePort {
  const domainModels = new Set(modelsOf(artifact).map(model => model.name));
  const checkModel = (model: string) => { if (domainModels.has(model) && !admitted()) fail('The original canonical invocation has not been independently admitted.'); if (domainModels.has(model) && ownerForModel(artifact, model)?.binding !== scope.binding) fail('A business invocation cannot read or mutate another storage authority.'); };
  const checkRecord = (model: string, id: string) => {
    checkModel(model);
    if (domainModels.has(model) && (rootIdOfRecord(id) !== scope.rootId || model === scope.model && id !== scope.rootId)) fail('A business invocation cannot read or mutate another root.');
  };
  const load = store.load, query = store.query, commit = store.commit, readReceipt = store.readReceipt;
  store.load = async (model, id) => { checkRecord(model, id); return load.call(store, model, id); };
  store.query = async spec => { checkModel(spec.model); return query.call(store, spec); };
  const historyFor = store.historyFor;
  store.historyFor = async (model, id) => { checkRecord(model, id); return historyFor.call(store, model, id); };
  if (store.uniqueOwner !== undefined) {
    const uniqueOwner = store.uniqueOwner;
    store.uniqueOwner = async (model, key, value) => { checkModel(model); return uniqueOwner.call(store, model, key, value); };
  }
  const cohortLoad = store.cohortLoad, cohortAnchorFact = store.cohortAnchorFact;
  store.cohortLoad = async input => { checkRecord(input.model, input.id); return cohortLoad.call(store, input); };
  store.cohortAnchorFact = async input => { checkRecord(input.model, input.id); return cohortAnchorFact.call(store, input); };
  const cohortIdentityPage = store.cohortIdentityPage, cohortRowPage = store.cohortRowPage;
  store.cohortIdentityPage = async input => { checkModel(input.model); return cohortIdentityPage.call(store, input); };
  store.cohortRowPage = async input => { checkModel(input.model); return cohortRowPage.call(store, input); };
  if (store.historyReadBounded !== undefined) {
    const historyReadBounded = store.historyReadBounded;
    store.historyReadBounded = async input => { checkRecord(input.model, input.recordId); return historyReadBounded.call(store, input); };
  }

  const checkReceipt = (receipt: ReceiptIdentity) => {
    if (receipt.app !== scope.app || receipt.owner !== scope.owner || !internal && receipt.principal !== scope.principal) fail('Root receipt requires its authenticated app, team and principal.');
  };
  store.readReceipt = async receipt => { checkReceipt(receipt); return readReceipt.call(store, receipt); };
  store.commit = async (batch: CommitBatch) => {
    if (batch.receipt !== null) checkReceipt(batch.receipt.identity);
    for (const write of batch.writes) {
      checkRecord(write.model, write.kind === 'insert' ? write.row.id : write.id);
      if (write.kind !== 'remove' && domainModels.has(write.model) && write.row.parent != null) checkRecord(write.row.parent.model, write.row.parent.id);
    }
    return commit.call(store, enqueueRootDirectoryUpdate(batch, scope, domainModels));
  };
  return store;
}

const PIN_SCHEMA = 'CREATE TABLE IF NOT EXISTS can_root_authority(id INTEGER PRIMARY KEY CHECK(id=1), app TEXT NOT NULL, owner TEXT NOT NULL, binding TEXT NOT NULL, model TEXT NOT NULL, root_id TEXT NOT NULL)';
function pin(storage: DurableObjectStorage, scope: RootScope): void {
  storage.transactionSync(() => {
    storage.sql.exec(PIN_SCHEMA);
    const rows = storage.sql.exec<{ app: string; owner: string; binding: string; model: string; root_id: string }>('SELECT app,owner,binding,model,root_id FROM can_root_authority WHERE id=1').toArray();
    if (rows.length === 0) {
      if (!scope.creating) return fail('The requested root authority does not exist.');
      storage.sql.exec('INSERT INTO can_root_authority(id,app,owner,binding,model,root_id) VALUES(1,?,?,?,?,?)', scope.app, scope.owner, scope.binding, scope.model, scope.rootId);
    } else if (rows.length !== 1 || rows[0]!.app !== scope.app || rows[0]!.owner !== scope.owner || rows[0]!.binding !== scope.binding || rows[0]!.model !== scope.model || rows[0]!.root_id !== scope.rootId) fail('The root belongs to another authenticated authority.');
  });
}

export interface RootAuthorityOptions {
  readonly artifact: CompileArtifact;
  /** Same host-owned canonical HTTP/MCP decoding on both sides; no identity DTO. */
  readonly invocation?: (request: Request, env: Record<string, unknown>) => Promise<RootInvocation>;
  /** Independently resolve the original credential against the real Identity owner. */
  readonly authenticate: (request: Request, env: Record<string, unknown>, invocation: RootInvocation) => Promise<RootIdentity>;
  /** Existing main receives the privately minted env composition; no alternate business executor. */
  readonly execute: (request: Request, env: Record<string, unknown>) => Promise<Response>;
  readonly directory?: (env: Record<string, unknown>) => RootDirectory;
  readonly locateFile?: (request: Request) => { readonly preview: boolean; readonly locator: { readonly model: string; readonly recordId: string } } | null;
  readonly fileReferences?: {
    readonly producers: readonly FrameworkFileReferenceProducer[];
    authority(env: Record<string, unknown>, scope: RootScope, physicalStateId: string): FileRetirementAuthority;
    prepare(env: Record<string, unknown>, store: FileReferenceStoragePort, scope: RootScope): Promise<void>;
  };
  /** Only the installed host runs verified retained Work; no operation DTO. */
  readonly recover?: (env: Record<string, unknown>, store: StoragePort, scope: RootScope,
    event?: { readonly eventId: string; readonly binding: string }) => Promise<{ readonly pending: boolean; readonly completed?: boolean }>;

}

/** Routing hints carry no identity or grant; actors authenticate and pin independently. */
export function rootAuthorityRequest(request: Request, scope: Pick<RootScope, 'binding' | 'rootId'>): Request {
  const headers = new Headers(request.headers);
  headers.set('x-can-root-route', JSON.stringify({ binding: scope.binding, rootId: scope.rootId }));
  return new Request(request, { headers });
}

/** Private namespace transport preserves original framing, credentials and the decoded locator.
 * The actor repeats the original HTTP/MCP handling; the locator never executes business code.
 */
async function originalRequestWire(original: Request) {
  const bytes = new Uint8Array(await original.clone().arrayBuffer());
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return { url: original.url, method: original.method, headers: [...original.headers], body: btoa(binary) };
}
export async function rootInvocationRequest(original: Request, invocation: RootInvocation, scope: Pick<RootScope, 'binding' | 'rootId'>): Promise<Request> {
  return new Request('http://can-root.internal/invoke', { method: 'POST', headers: { 'content-type': 'application/x-can-root-invocation+json' },
    body: JSON.stringify({ kind: 'can-root-invocation/v1', invocation, locator: scope, request: await originalRequestWire(original) }) });
}
export async function rootFileRequest(original: Request, file: unknown, scope: Pick<RootScope, 'binding' | 'rootId'>): Promise<Request> {
  return new Request('http://can-root.internal/file', { method: 'POST', headers: { 'content-type': 'application/x-can-root-file+json' },
    body: JSON.stringify({ kind: 'can-root-file/v1', file, locator: scope, request: await originalRequestWire(original) }) });
}

type CheckedInvocationTransport = {
  readonly request: { readonly url: string; readonly method: string; readonly headers: unknown; readonly body: string };
  readonly locator: { readonly binding: string; readonly rootId: string };
  readonly invocation: unknown; readonly file: unknown;
};

function checkInvocationTransport(value: unknown, kind: string): CheckedInvocationTransport {
  if (!plain(value) || (kind === 'application/x-can-root-invocation+json' ? value.kind !== 'can-root-invocation/v1' || !plain(value.invocation) : value.kind !== 'can-root-file/v1' || !plain(value.file)) || !plain(value.request) || !plain(value.locator) ||
      typeof value.request.url !== 'string' || typeof value.request.method !== 'string' || !Array.isArray(value.request.headers) || typeof value.request.body !== 'string' ||
      typeof value.locator.binding !== 'string' || typeof value.locator.rootId !== 'string' || kind === 'application/x-can-root-invocation+json' && (!plain(value.invocation) || typeof value.invocation.operation !== 'string' || !plain(value.invocation.inputs))) return fail('Invalid internal root invocation transport.');
  return value as CheckedInvocationTransport;
}

async function unwrapInvocation(request: Request): Promise<{ request: Request; invocation?: RootInvocation; file?: unknown } | null> {
  const kind = request.headers.get('content-type');
  if (kind !== 'application/x-can-root-invocation+json' && kind !== 'application/x-can-root-file+json') return null;
  const value = checkInvocationTransport(await request.json(), kind);
  const bytes = Uint8Array.from(atob(value.request.body), char => char.charCodeAt(0));
  const headers = new Headers(value.request.headers as [string, string][]); headers.delete('content-length');
  const original = new Request(value.request.url, { method: value.request.method, headers,
    ...(['GET', 'HEAD'].includes(value.request.method) ? {} : { body: bytes }) });
  return { request: rootAuthorityRequest(original, { binding: value.locator.binding, rootId: value.locator.rootId }), ...(kind === 'application/x-can-root-invocation+json' ? { invocation: value.invocation as unknown as RootInvocation } : { file: value.file }) };
}

async function resolveBrowseScope(scope: RootBrowse, request: Request): Promise<RootScope> {
  let hint: unknown;
  try { hint = JSON.parse(request.headers.get('x-can-root-route') ?? 'null'); } catch { return fail('Root read has an invalid routing locator.'); }
  if (!plain(hint) || hint.binding !== scope.binding || typeof hint.rootId !== 'string' || rootIdOfRecord(hint.rootId) !== hint.rootId) return fail('Root browsing requires a directly located owner.');
  return Object.freeze({ app: scope.app, owner: scope.owner, principal: scope.principal, binding: scope.binding,
    model: scope.model, rootId: hint.rootId, creating: false });
}

/** Production actor surface is a complete original request, never arbitrary StoragePort methods. */
export function createRootAuthorityClass(options: RootAuthorityOptions): new (
  state: DurableObjectState, env: Record<string, unknown>,
) => { fetch(request: Request): Promise<Response>; alarm(): Promise<void> } {
  return class CanRootAuthority {
    private serial: Promise<unknown> = Promise.resolve();
    constructor(private readonly state: DurableObjectState, private readonly env: Record<string, unknown>) {}
    private exclusive<Value>(run: () => Promise<Value>): Promise<Value> {
      const result = this.serial.then(run, run);
      this.serial = result.then(() => undefined, () => undefined);
      return result;
    }
    fetch(request: Request): Promise<Response> {
      return this.exclusive(() => new URL(request.url).origin === 'http://can-root.internal' && new URL(request.url).pathname === '/resources'
        ? this.wake(request) : this.invoke(request)).catch(error => {
        const kind = request.headers.get('content-type');
        if (kind === 'application/x-can-root-file+json') {
          if (error instanceof StateError && (error.code === 'forbidden' || error.code === 'rule_failed' || error.code === 'not_found')) return new Response(null, { status: 404 });
          if (error instanceof IdentityError) return Response.json({ code: error.code, message: error.message }, { status: 401 });
        }
        if (kind === 'application/x-can-root-invocation+json' && (error instanceof StateError || error instanceof IdentityError)) {
          return Response.json({ error: { code: error.code, message: error.message, retryable: false } }, { headers: { 'x-can-root-outcome': 'v1' } });
        }
        throw error;
      });
    }
    private pinned(): RootScope | null {
      this.state.storage.sql.exec(PIN_SCHEMA);
      const rows = this.state.storage.sql.exec<{app: string; owner: string; binding: string; model: string; root_id: string}>('SELECT app,owner,binding,model,root_id FROM can_root_authority WHERE id=1').toArray();
      const row = rows[0];
      if (row === undefined) return null;
      const namespace = this.env[row.binding] as DurableObjectNamespace | undefined;
      if (rows.length !== 1 || namespace === undefined || !namespace.idFromName(row.root_id).equals(this.state.id) ||
          !bindingsOf(options.artifact).some(binding => binding.binding === row.binding && binding.key === row.model)) return fail('Retained root recovery lost its physical checked authority.');
      return {app: row.app, owner: row.owner, principal: 'can.root.recovery', binding: row.binding, model: row.model, rootId: row.root_id, creating: false};
    }
    private async createStore(scope: RootScope): Promise<StoragePort> {
      await ensureSchema(this.state.storage);
      const files = options.fileReferences;
      if (files === undefined) return createDOStorage(this.state.storage);
      const store = createDOStorage(this.state.storage, files.authority(this.env, scope, this.state.id.toString()), files.producers);
      await files.prepare(this.env, store, scope);
      return store;
    }
    private async recover(event?: {readonly eventId: string; readonly binding: string}): Promise<boolean> {
      const scope = this.pinned();
      if (scope === null) return fail('Root recovery requires an existing committed authority.');
      const store = guardRootStore(await this.createStore(scope), options.artifact, scope, () => true, true);
      // Arm before any awaited delivery: crashes/platform retries retain a wake.
      await this.state.storage.setAlarm(Date.now() + 5_000);
      let pending = false, completed = false;
      if (options.recover !== undefined) {
        const result = await options.recover(this.env, store, scope, event);
        pending = result.pending; completed = result.completed === true;
      } else if (event !== undefined) return fail('No verified queue recovery host is installed.');
      if (options.directory !== undefined) await projectRootDirectoryUpdates(store, scope, options.directory(this.env));
      pending ||= (await store.outboxPending()).some(intent => intent.target === 'can.runtime.root-directory');
      if (!pending) await this.state.storage.deleteAlarm();
      return completed;
    }
    alarm(): Promise<void> { return this.exclusive(async () => { await this.recover(); }); }
    private async wake(request: Request): Promise<Response> {
      if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/x-can-root-resources+json') return new Response('Invalid root wake', {status: 400});
      const body: unknown = await request.json(), scope = this.pinned();
      if (!plain(body) || Object.keys(body).sort().join(',') !== 'binding,eventId,rootId' || scope === null || body.rootId !== scope.rootId ||
          typeof body.eventId !== 'string' || body.eventId.length === 0 || body.eventId.length > 200 || typeof body.binding !== 'string' ||
          !options.artifact.runtimeBindings?.some(binding => binding.kind === 'queue' && binding.binding === body.binding)) return new Response('Invalid root queue locator', {status: 403});
      const completed = await this.recover({eventId: body.eventId, binding: body.binding});
      return Response.json({completed}, {status: completed ? 200 : 503});
    }
    private async invoke(request: Request): Promise<Response> {
      const transport = await unwrapInvocation(request);
      request = transport?.request ?? request;
      const loadInvocation = async () => {
        const file = transport?.file === undefined ? undefined : options.locateFile?.(request) ?? undefined;
        if (transport?.file !== undefined && (file == null || stableStringify(file) !== stableStringify(transport.file))) return fail('The original protected File request changed.');
        const invocation = file == null ? transport?.invocation ?? await options.invocation?.(request.clone(), this.env) : { operation: `${file.locator.model}.read`, inputs: {} };
        return { file, invocation };
      };
      const { file, invocation } = await loadInvocation();
      if (invocation === undefined) return fail('A root actor accepts only the internal original-request transport.');
      const authenticated = identity(await options.authenticate(request.clone(), this.env, invocation));
      let scope = file == null ? await resolveRootAuthority(options.artifact, invocation, authenticated)
        : rootAuthorityForRecord(options.artifact, file.locator.model, file.locator.recordId, authenticated);
      if (scope !== null && 'browse' in scope) scope = await resolveBrowseScope(scope, request);
      if (scope === null) return fail('A root actor requires one directly selected authority.');
      const namespace = this.env[scope.binding] as DurableObjectNamespace | undefined;
      if (namespace === undefined || !namespace.idFromName(scope.rootId).equals(this.state.id)) return fail('The request reached a different physical root authority.');
      pin(this.state.storage, scope);
      let admitted = false;
      const store = guardRootStore(await this.createStore(scope), options.artifact, scope, () => admitted);
      const allocateId = await createRootRecordAllocator(options.artifact, scope, invocation);
      const env = { ...this.env };
      const pinned = scope;
      let captured: unknown;
      executions.set(env, Object.freeze({ scope, identity: authenticated, store, allocateId,
        async assertInvocation(actual: RootInvocation, current: RootIdentity) {
          if (file !== undefined) return fail('Protected File composition cannot execute a business operation.');
          if (current.app !== authenticated.app || current.owner !== authenticated.owner || current.principal !== authenticated.principal ||
              actual.operation !== invocation.operation || actual.operation_id !== invocation.operation_id || stableStringify(actual.inputs) !== stableStringify(invocation.inputs)) return fail('The independently admitted root invocation changed.');
          const route = await resolveRootAuthority(options.artifact, actual, current);
          if (route === null || route.binding !== pinned.binding || !('browse' in route) && route.rootId !== pinned.rootId) return fail('The canonical invocation belongs to a different root authority.');
          admitted = true;
        },
        async assertFileRequest(actual: unknown, current: RootIdentity) {
          if (file === undefined || current.app !== authenticated.app || current.owner !== authenticated.owner || current.principal !== authenticated.principal || stableStringify(actual) !== stableStringify(file)) return fail('The independently admitted protected File request changed.');
          const route = rootAuthorityForRecord(options.artifact, file.locator.model, file.locator.recordId, current);
          if (route === null || route.binding !== pinned.binding || route.rootId !== pinned.rootId) return fail('The protected File belongs to another root authority.');
          admitted = true;
        },
        captureOutcome(outcome: unknown) { captured = outcome; },
      }));
      const runExecution = async (): Promise<Response> => {
        const wakeAt = Date.now() + 1_000;
        const existingAlarm = await this.state.storage.getAlarm();
        if (existingAlarm === null || existingAlarm > wakeAt) await this.state.storage.setAlarm(wakeAt);
        const response = await options.execute(request, env);
        if (options.directory !== undefined) this.state.waitUntil(projectRootDirectoryUpdates(store, scope, options.directory(this.env)).catch(() => {
          // Eventual indexing failure keeps the committed outbox item pending.
          // Direct root references continue to resolve independently.
        }));
        return transport?.invocation !== undefined && captured !== undefined
          ? Response.json(captured, { headers: { 'x-can-root-outcome': 'v1' } }) : response;
      };
      try {
        return await runExecution();
      } finally { executions.delete(env); }
    }
  };
}
