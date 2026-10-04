/**
 * Interfaces ports: clock, structured logging, operation input shapes.
 *
 * `SchemaCatalog` is the minimal per-operation input-shape lookup the
 * envelope validators need. The production binding reads the owning L1
 * operation registry (join J3); tests use a stub map. Full JSON-schema
 * validation of business inputs stays with the canonical invocation (L3);
 * this layer checks framing only (closed members, required presence).
 */
export interface InterfacesClock {
  nowMs(): number;
}

export const systemInterfacesClock: InterfacesClock = { nowMs: () => Date.now() };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured log sink. Implementations must never log secrets; use
 * `errors/redact` before journaling untrusted values. */
export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

/** Minimal input-shape descriptor for one canonical operation. */
export interface OperationInputShape {
  /** Allowed top-level input members (closed object). */
  readonly allowed: readonly string[];
  /** Required top-level input members (subset of allowed). */
  readonly required: readonly string[];
}

export interface SchemaCatalog {
  shapeFor(operation: string): OperationInputShape | null;
}

/* ------------------------------------------------------------------ */
/* S4 HTTP dispatch ports.                                             */
/*                                                                     */
/* Production bindings: AppInfo + PageRegistry read the owning L1      */
/* artifact/registry (join J3); OperationInvoker is the L3 canonical   */
/* invocation callable (join J2); RateLimiter counters live in durable */
/* storage at B1 (memory double here is per-isolate only). Tests use    */
/* the doubles in testing.ts.                                          */
/* ------------------------------------------------------------------ */

import type {
  BusinessError,
  MessageValue,
  MutationEnvelope,
  MutationResult,
  PageDescriptor,
  ReadEnvelope,
  ReadResult,
  ResolvedIdentity,
} from '@canlang/contracts';
import type { Clock, IdentityStore, MailPort } from '@canlang/identity';

/** Owning-app facts the shell needs. L1 binds from appDefinition. */
export interface AppInfo {
  readonly brand: MessageValue;
  readonly appDefaultLocale: string;
  /** Owner labels keyed by canonical owner (package metadata). */
  readonly ownerLabels: ReadonlyMap<string, MessageValue>;
}

/** Source-derived page set, in appDefinition.pages order. L1 binds. */
export interface PageRegistry {
  descriptors(): readonly PageDescriptor[];
}

/** Canonical invocation outcome: result or safe business error. */
export type MutationOutcome = { result: MutationResult } | { error: BusinessError };
export type ReadOutcome = { result: ReadResult } | { error: BusinessError };

/** L3 canonical invocation callable (admission + commit + projection). */
export interface OperationInvoker {
  invokeMutation(envelope: MutationEnvelope, identity: ResolvedIdentity): Promise<MutationOutcome>;
  invokeRead(envelope: ReadEnvelope, identity: ResolvedIdentity): Promise<ReadOutcome>;
}

/** Fixed-window rate check for unauthenticated auth endpoints. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}

/** Identity stack for auth routes + request identity resolution. */
export interface IdentityDeps {
  readonly store: IdentityStore;
  readonly mail: MailPort;
  readonly clock: Clock;
  /** Absolute page URLs receiving `?token=` links (browser routes). */
  readonly verifyBaseUrl: string;
  readonly recoveryBaseUrl: string;
  readonly inviteBaseUrl: string;
  readonly sessionMaxAgeSeconds: number;
}

/**
 * Assembled HTTP dependencies. The L7 worker assembly constructs these
 * from environment bindings at B1; S4 tests construct them directly.
 */
export interface HttpDeps {
  readonly app: AppInfo;
  readonly pages: PageRegistry;
  readonly invoker: OperationInvoker;
  readonly catalog: SchemaCatalog;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
  readonly identity: IdentityDeps;
  /** Secure cookie flag; false only for local http:// development. */
  readonly secureCookies: boolean;
}

/* ------------------------------------------------------------------ */
/* S5 MCP server ports.                                                */
/*                                                                     */
/* Production bindings: OperationRegistry reads the owning L1          */
/* operation registry (join J3) with author descriptions and typed     */
/* input fields; McpPermissions rechecks L3 grants per call (join J2); */
/* McpFilesInfo reports L1/L7 file-upload support. Tests use the       */
/* doubles in testing.ts.                                              */
/* ------------------------------------------------------------------ */

/** Typed input field for generated MCP tool schemas (closed objects). */
export type McpSchemaField =
  | { readonly kind: 'ref'; readonly model: string; readonly requireVersion: boolean }
  | { readonly kind: 'string' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'decimal' }
  | { readonly kind: 'money' }
  | { readonly kind: 'datetime' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'file' }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

export interface McpNamedField {
  readonly name: string;
  readonly field: McpSchemaField;
  readonly required: boolean;
}

/** Typed input schema for one operation; rendered closed. */
export interface McpInputSchema {
  readonly fields: readonly McpNamedField[];
}

export type McpOperationKind =
  | 'read'
  | 'list'
  | 'create'
  | 'update'
  | 'delete'
  | 'scenario'
  | 'team';

/**
 * One generated tool source: canonical operation name, authored `#`
 * description, kind, and typed inputs. Descriptions are derived once here;
 * both transports share the same registry.
 */
export interface OperationDescriptor {
  /** Canonical name: `package.Model.read`, `package.scenario`, `system.team.*`. */
  readonly name: string;
  readonly kind: McpOperationKind;
  /** Authored `#` description text, verbatim. */
  readonly description: string;
  readonly inputs: McpInputSchema;
}

/** Owning-operation registry the MCP tool list is generated from. */
export interface OperationRegistry {
  list(app: AppInfo): readonly OperationDescriptor[];
}

/**
 * Per-call permission rechecks against current identity/grants. Discovery
 * filters the tool list; invocation rechecks before every call.
 */
export interface McpPermissions {
  canDiscover(identity: ResolvedIdentity, operation: string): boolean | Promise<boolean>;
  canCall(identity: ResolvedIdentity, operation: string): boolean | Promise<boolean>;
}

/** File-upload support facts for the `_meta` capability advertisement. */
export interface McpFilesInfo {
  usesFiles(app: AppInfo): boolean;
  intentsUrl(app: AppInfo): string;
}

/** Assembled MCP dependencies. The L7 worker assembly constructs these. */
export interface McpDeps {
  readonly app: AppInfo;
  readonly registry: OperationRegistry;
  readonly permissions: McpPermissions;
  readonly invoker: OperationInvoker;
  readonly catalog: SchemaCatalog;
  readonly files: McpFilesInfo;
  readonly identity: IdentityDeps;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
}
