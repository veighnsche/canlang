/**
 * Test-only HTTP doubles: fake invoker/registry/catalog/limiter, app info,
 * and an authenticated-request builder over the real @canlang/identity
 * memory store.
 *
 * NEVER production. The fakes script outcomes for dispatch tests; the
 * production bindings are L1 (registry/catalog/app), L3 (invoker), and
 * durable rate-limit counters at B1. Import from tests only, never from
 * `src/index.ts`.
 */
import type {
  BusinessError,
  MutationEnvelope,
  PageDescriptor,
  ReadEnvelope,
  ResolvedIdentity,
  UploadIntentRequest,
} from '@canlang/contracts';
import {
  createMemoryIdentityStore,
  createTestMailOutbox,
} from '@canlang/identity/testing';
import { loginWithPassword, registerWithEmail, verifyEmail } from '@canlang/identity';
import type { IdentityStore, MailPort } from '@canlang/identity';
import { buildSessionCookie, issueMcpGrant } from '@canlang/identity';
import type {
  AppInfo,
  FileKernel,
  FileUseInfo,
  HttpDeps,
  IngressBinding,
  IngressBindings,
  IngressDeps,
  IngressSink,
  IngressVerifier,
  KernelAppendOutcome,
  KernelCompleteOutcome,
  KernelCreateOutcome,
  KernelFinalizeOutcome,
  Logger,
  McpDeps,
  McpFilesInfo,
  McpPermissions,
  MutationOutcome,
  OAuthDeps,
  OperationDescriptor,
  OperationInputShape,
  OperationInvoker,
  OperationRegistry,
  PageRegistry,
  RateLimiter,
  ReadOutcome,
  SchemaCatalog,
  UploadBinding,
  UploadDeps,
  UploadReceiver,
  VerifiedIngressEnvelope,
} from './ports.js';
import { systemInterfacesClock } from './ports.js';

/** Scripted invoker: per-operation handlers with a call log. */
export function createFakeInvoker(handlers: {
  mutations?: Record<string, (envelope: MutationEnvelope, identity: ResolvedIdentity) => MutationOutcome | Promise<MutationOutcome>>;
  reads?: Record<string, (envelope: ReadEnvelope, identity: ResolvedIdentity) => ReadOutcome | Promise<ReadOutcome>>;
}): OperationInvoker & {
  mutations: Array<{ envelope: MutationEnvelope; identity: ResolvedIdentity }>;
  reads: Array<{ envelope: ReadEnvelope; identity: ResolvedIdentity }>;
} {
  const mutations: Array<{ envelope: MutationEnvelope; identity: ResolvedIdentity }> = [];
  const reads: Array<{ envelope: ReadEnvelope; identity: ResolvedIdentity }> = [];
  return {
    mutations,
    reads,
    async invokeMutation(envelope, identity) {
      mutations.push({ envelope, identity });
      const handler = handlers.mutations?.[envelope.operation];
      if (handler === undefined) {
        const error: BusinessError = {
          code: 'not_found',
          message: 'Unknown operation.',
          retryable: false,
        };
        return { error };
      }
      return handler(envelope, identity);
    },
    async invokeRead(envelope, identity) {
      reads.push({ envelope, identity });
      const handler = handlers.reads?.[envelope.operation];
      if (handler === undefined) {
        const error: BusinessError = {
          code: 'not_found',
          message: 'Unknown operation.',
          retryable: false,
        };
        return { error };
      }
      return handler(envelope, identity);
    },
  };
}

export function createFakeRegistry(
  descriptors: readonly PageDescriptor[],
): PageRegistry {
  return { descriptors: () => descriptors };
}

export function createFakeCatalog(
  shapes: Record<string, OperationInputShape>,
): SchemaCatalog {
  return { shapeFor: (operation: string) => shapes[operation] ?? null };
}

/** Fixed-window memory limiter (per-isolate; production counters differ). */
export function createMemoryRateLimiter(): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    async check(key: string, limit: number, windowMs: number) {
      const now = Date.now();
      const window = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
      if (window.length >= limit) {
        const oldest = window[0] ?? now;
        return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - oldest)) };
      }
      window.push(now);
      hits.set(key, window);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

export function createTestApp(): AppInfo {
  return {
    appId: 'test-app',
    brand: 'Test App',
    appDefaultLocale: 'en',
    ownerLabels: new Map([['TestApp', 'Test App']]),
  };
}

export interface RecordedLog {
  readonly level: string;
  readonly message: string;
  readonly fields: Record<string, unknown> | undefined;
}

export function createRecordingLogger(): Logger & { calls: RecordedLog[] } {
  const calls: RecordedLog[] = [];
  return {
    calls,
    log(level, message, fields) {
      calls.push({ level, message, fields });
    },
  };
}

export interface IdentityFixture {
  readonly store: IdentityStore;
  readonly mail: MailPort & { messages: Array<{ to: string; subject: string; body_text: string }> };
  readonly userId: string;
  readonly email: string;
  readonly teamId: string;
  readonly sessionToken: string;
  readonly cookie: string;
}

/**
 * Real identity stack over the memory store: one verified user, one team
 * with owner membership, one live session. Returns the session cookie for
 * authenticated requests.
 */
export async function createIdentityFixture(opts: {
  email?: string;
  password?: string;
  secureCookies?: boolean;
} = {}): Promise<IdentityFixture> {
  const store = createMemoryIdentityStore();
  const mail = createTestMailOutbox();
  const email = opts.email ?? 'ada@test.example';
  const password = opts.password ?? 's3cure-password';
  await registerWithEmail(store, mail, { email, password }, { verifyBaseUrl: 'https://test.invalid/verify' });
  const token = (mail.messages[0]?.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  const { user_id } = await verifyEmail(store, { token });
  const team = await store.createTeam({});
  await store.createMembership({ team_id: team.team_id, user_id, is_owner: true, roles: [] });
  const { token: sessionToken } = await loginWithPassword(store, { email, password });
  const cookie = buildSessionCookie(sessionToken, {
    maxAgeSeconds: 3600,
    secure: opts.secureCookies ?? false,
  });
  return { store, mail, userId: user_id, email, teamId: team.team_id, sessionToken, cookie };
}

/** Build a Request with optional cookie + headers against the test origin. */
export function testRequest(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  const { cookie: _dropped, ...rest } = init;
  void _dropped;
  return new Request(`https://test.invalid${path}`, { ...rest, headers });
}

export interface TestDeps {
  readonly deps: HttpDeps;
  readonly logger: Logger & { calls: RecordedLog[] };
  readonly invoker: OperationInvoker & {
    mutations: Array<{ envelope: MutationEnvelope; identity: ResolvedIdentity }>;
    reads: Array<{ envelope: ReadEnvelope; identity: ResolvedIdentity }>;
  };
  readonly identity: IdentityFixture;
}

/** Test IdentityDeps over a fixture's store with frozen base URLs. */
export function createTestIdentityDeps(fixture: IdentityFixture): HttpDeps['identity'] {
  return {
    store: fixture.store,
    mail: fixture.mail,
    clock: { nowMs: () => Date.now() },
    verifyBaseUrl: 'https://test.invalid/auth/verify',
    recoveryBaseUrl: 'https://test.invalid/auth/recover',
    inviteBaseUrl: 'https://test.invalid',
    sessionMaxAgeSeconds: 3600,
  };
}

/* ------------------------------------------------------------------ */
/* S5 MCP doubles.                                                   */
/* ------------------------------------------------------------------ */

export function createFakeOperationRegistry(
  descriptors: readonly OperationDescriptor[],
): OperationRegistry {
  return { list: () => descriptors };
}

/** Scripted permissions: per-operation discover/call grants. */
export function createFakePermissions(opts: {
  discover?: Record<string, boolean>;
  call?: Record<string, boolean>;
} = {}): McpPermissions {
  return {
    canDiscover: (_identity, operation) => opts.discover?.[operation] ?? true,
    canCall: (_identity, operation) => opts.call?.[operation] ?? true,
  };
}

export function createFakeMcpFilesInfo(opts: {
  usesFiles?: boolean;
  intentsUrl?: string;
} = {}): McpFilesInfo {
  return {
    usesFiles: () => opts.usesFiles ?? false,
    intentsUrl: () => opts.intentsUrl ?? 'https://test.invalid/files/intents',
  };
}

/** Issue a real grant for the fixture user/team over the memory store. */
export async function createGrantFixture(identity: IdentityFixture): Promise<{ token: string }> {
  const { token } = await issueMcpGrant(
    identity.store,
    { user_id: identity.userId, team_id: identity.teamId, client_id: 'test-client' },
    {},
  );
  return { token };
}

export interface TestMcpDeps {
  readonly deps: McpDeps;
  readonly logger: Logger & { calls: RecordedLog[] };
  readonly invoker: OperationInvoker & {
    mutations: Array<{ envelope: MutationEnvelope; identity: ResolvedIdentity }>;
    reads: Array<{ envelope: ReadEnvelope; identity: ResolvedIdentity }>;
  };
  readonly identity: IdentityFixture;
  readonly grantToken: string;
}

/** Assemble McpDeps from fakes: real identity fixture + live grant token. */
export async function createTestMcpDeps(opts: {
  descriptors?: readonly OperationDescriptor[];
  shapes?: Record<string, OperationInputShape>;
  mutations?: Record<string, (envelope: MutationEnvelope, identity: ResolvedIdentity) => MutationOutcome | Promise<MutationOutcome>>;
  reads?: Record<string, (envelope: ReadEnvelope, identity: ResolvedIdentity) => ReadOutcome | Promise<ReadOutcome>>;
  discover?: Record<string, boolean>;
  call?: Record<string, boolean>;
  usesFiles?: boolean;
} = {}): Promise<TestMcpDeps> {
  const logger = createRecordingLogger();
  const invoker = createFakeInvoker({
    ...(opts.mutations === undefined ? {} : { mutations: opts.mutations }),
    ...(opts.reads === undefined ? {} : { reads: opts.reads }),
  });
  const identity = await createIdentityFixture({});
  const { token: grantToken } = await createGrantFixture(identity);
  return {
    logger,
    invoker,
    identity,
    grantToken,
    deps: {
      app: createTestApp(),
      registry: createFakeOperationRegistry(opts.descriptors ?? []),
      permissions: createFakePermissions({
        ...(opts.discover === undefined ? {} : { discover: opts.discover }),
        ...(opts.call === undefined ? {} : { call: opts.call }),
      }),
      invoker,
      catalog: createFakeCatalog(opts.shapes ?? {}),
      files: createFakeMcpFilesInfo({
        ...(opts.usesFiles === undefined ? {} : { usesFiles: opts.usesFiles }),
      }),
      identity: createTestIdentityDeps(identity),
      logger,
      clock: systemInterfacesClock,
    },
  };
}

/* ------------------------------------------------------------------ */
/* S6 upload doubles.                                                */
/* ------------------------------------------------------------------ */

export function createFakeFileUseInfo(usesFiles = true): FileUseInfo {
  return { usesFiles: () => usesFiles };
}

/** Scripted file kernel with a call log. Mirrors L4 outcome shapes. */
export function createFakeKernel(handlers: {
  maxBytes?: number;
  createIntent?: (input: { request: UploadIntentRequest; receiver: UploadReceiver; binding: UploadBinding }) => KernelCreateOutcome | Promise<KernelCreateOutcome>;
  append?: (intentId: string, caller: UploadReceiver, chunk: Uint8Array) => KernelAppendOutcome | Promise<KernelAppendOutcome>;
  complete?: (intentId: string, caller: UploadReceiver) => KernelCompleteOutcome | Promise<KernelCompleteOutcome>;
  finalize?: (input: { intentId: string; retryId: string; bytesDigest: string; caller: UploadReceiver }) => KernelFinalizeOutcome | Promise<KernelFinalizeOutcome>;
} = {}): FileKernel & {
  calls: Array<{ method: string; detail: unknown }>;
} {
  const calls: Array<{ method: string; detail: unknown }> = [];
  return {
    calls,
    maxBytes: () => handlers.maxBytes ?? 1024,
    async createIntent(input) {
      calls.push({ method: 'createIntent', detail: input });
      if (handlers.createIntent === undefined) throw new Error('fake kernel: createIntent not scripted');
      return handlers.createIntent(input);
    },
    async append(intentId, caller, chunk) {
      calls.push({ method: 'append', detail: { intentId, caller, bytes: chunk.length } });
      if (handlers.append === undefined) throw new Error('fake kernel: append not scripted');
      return handlers.append(intentId, caller, chunk);
    },
    async complete(intentId, caller) {
      calls.push({ method: 'complete', detail: { intentId, caller } });
      if (handlers.complete === undefined) throw new Error('fake kernel: complete not scripted');
      return handlers.complete(intentId, caller);
    },
    async finalize(input) {
      calls.push({ method: 'finalize', detail: input });
      if (handlers.finalize === undefined) throw new Error('fake kernel: finalize not scripted');
      return handlers.finalize(input);
    },
  };
}

export interface TestUploadDeps {
  readonly deps: UploadDeps;
  readonly logger: Logger & { calls: RecordedLog[] };
  readonly kernel: FileKernel & { calls: Array<{ method: string; detail: unknown }> };
  readonly identity: IdentityFixture;
}

/* ------------------------------------------------------------------ */
/* S7 ingress + OAuth doubles.                                       */
/* ------------------------------------------------------------------ */

export function createFakeBindings(bindings: readonly IngressBinding[]): IngressBindings {
  const byNamespace = new Map(bindings.map((b) => [b.namespace, b]));
  return { bindingFor: (namespace: string) => byNamespace.get(namespace) ?? null };
}

export function createTestBinding(overrides: Partial<IngressBinding> = {}): IngressBinding {
  return {
    namespace: 'acme-billing',
    adapter: 'test-hmac',
    team: 'team-1',
    owner: 'team-1',
    ...overrides,
  };
}

export function createTestEnvelope(overrides: Partial<VerifiedIngressEnvelope> = {}): VerifiedIngressEnvelope {
  return {
    namespace: 'acme-billing',
    producerEventId: 'evt-1',
    operationKind: 'charge',
    requestDigest: 'sha256:abc',
    deliveryId: null,
    ...overrides,
  };
}

/** Scripted verifier: per-namespace envelope or null (fail closed). */
export function createFakeVerifier(
  results: Record<string, VerifiedIngressEnvelope | null>,
): IngressVerifier & { calls: Array<{ binding: IngressBinding; bytes: number }> } {
  const calls: Array<{ binding: IngressBinding; bytes: number }> = [];
  return {
    calls,
    async verify(binding, input) {
      calls.push({ binding, bytes: input.body.length });
      return results[binding.namespace] ?? null;
    },
  };
}

/** Recording sink with a scripted accept flag. */
export function createFakeSink(accepted = true): IngressSink & {
  calls: Array<{ context: unknown; event: unknown }>;
} {
  const calls: Array<{ context: unknown; event: unknown }> = [];
  return {
    calls,
    async accept(context, event) {
      calls.push({ context, event });
      return { accepted };
    },
  };
}

export interface TestIngressDeps {
  readonly deps: IngressDeps;
  readonly logger: Logger & { calls: RecordedLog[] };
  readonly verifier: IngressVerifier & { calls: Array<{ binding: IngressBinding; bytes: number }> };
  readonly sink: IngressSink & { calls: Array<{ context: unknown; event: unknown }> };
}

export function createTestIngressDeps(opts: {
  bindings?: readonly IngressBinding[];
  verify?: Record<string, VerifiedIngressEnvelope | null>;
  accepted?: boolean;
} = {}): TestIngressDeps {
  const logger = createRecordingLogger();
  const verifier = createFakeVerifier(opts.verify ?? {});
  const sink = createFakeSink(opts.accepted ?? true);
  return {
    logger,
    verifier,
    sink,
    deps: {
      bindings: createFakeBindings(opts.bindings ?? [createTestBinding()]),
      verifier,
      sink,
      logger,
      clock: systemInterfacesClock,
    },
  };
}

export interface TestOAuthDeps {
  readonly deps: OAuthDeps;
  readonly logger: Logger & { calls: RecordedLog[] };
  readonly identity: IdentityFixture;
}

/** Assemble OAuthDeps with a real identity fixture. */
export async function createTestOAuthDeps(): Promise<TestOAuthDeps> {
  const logger = createRecordingLogger();
  const identity = await createIdentityFixture({});
  return {
    logger,
    identity,
    deps: {
      identity: createTestIdentityDeps(identity),
      limiter: createMemoryRateLimiter(),
      logger,
      clock: systemInterfacesClock,
    },
  };
}

/** Assemble UploadDeps from fakes with a real identity fixture. */
export async function createTestUploadDeps(opts: {
  usesFiles?: boolean;
  kernel?: Parameters<typeof createFakeKernel>[0];
} = {}): Promise<TestUploadDeps> {
  const logger = createRecordingLogger();
  const kernel = createFakeKernel(opts.kernel ?? {});
  const identity = await createIdentityFixture({});
  return {
    logger,
    kernel,
    identity,
    deps: {
      app: createTestApp(),
      files: createFakeFileUseInfo(opts.usesFiles ?? true),
      kernel,
      identity: createTestIdentityDeps(identity),
      logger,
      clock: systemInterfacesClock,
    },
  };
}

/** Assemble HttpDeps from fakes with recording logger + call logs. Async: builds a real identity fixture (verified owner + session). */
export async function createTestDeps(opts: {
  descriptors?: readonly PageDescriptor[];
  shapes?: Record<string, OperationInputShape>;
  mutations?: Record<string, (envelope: MutationEnvelope, identity: ResolvedIdentity) => MutationOutcome | Promise<MutationOutcome>>;
  reads?: Record<string, (envelope: ReadEnvelope, identity: ResolvedIdentity) => ReadOutcome | Promise<ReadOutcome>>;
  secureCookies?: boolean;
} = {}): Promise<TestDeps> {
  const logger = createRecordingLogger();
  const invoker = createFakeInvoker({
    ...(opts.mutations === undefined ? {} : { mutations: opts.mutations }),
    ...(opts.reads === undefined ? {} : { reads: opts.reads }),
  });
  const identity = await createIdentityFixture({ secureCookies: opts.secureCookies ?? false });
  return {
    logger,
    invoker,
    identity,
    deps: {
      app: createTestApp(),
      pages: createFakeRegistry(opts.descriptors ?? []),
      invoker,
      catalog: createFakeCatalog(opts.shapes ?? {}),
      limiter: createMemoryRateLimiter(),
      logger,
      clock: systemInterfacesClock,
      identity: createTestIdentityDeps(identity),
      secureCookies: opts.secureCookies ?? false,
      uploads: { files: createFakeFileUseInfo(false), kernel: createFakeKernel({}) },
      ingress: {
        bindings: createFakeBindings([]),
        verifier: createFakeVerifier({}),
        sink: createFakeSink(),
      },
    },
  };
}
