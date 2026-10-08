/**
 * B1 handler context: the `c` in emitted `async op(c, …)` handlers.
 *
 * INTERIM B1 binding — handoff to L3. This context is the minimal carrier the
 * B1 interim data-plane stdlib (`./stdlib.js`) needs: caller identity, the
 * state-engine storage port, a clock, and membership labels. L3 must
 * formalize: operation identity (name/id for receipts and history), the
 * admission/policy wiring (`InvocationContext`, `PolicyTable`,
 * `MembershipReader`), and the L1 T4 call-shape contract for handler args.
 *
 * T17b: the L3 formalization lands as the optional `canonical` scope below.
 * The canonical scenario seam (`./invoke.js` `runScenarioSeam`) installs it
 * (operation identity + the engine-backed stage/read closures); the migrated
 * stdlib data plane stages every write through it and serves every read
 * through it. Absent outside canonical execution — and the T17 retirement
 * removed every serving path outside canonical execution, so a missing scope
 * fails loud instead of committing directly.
 */
import type { DatetimeValue, DeliveryRef, InvocationContext, ProjectedRecord, RecordParent, StoragePort, StoredRow, UserRef } from '@canlang/contracts';
import { makeDatetime, makeUserRef } from '@canlang/values';

/** Authenticated caller identity: stable user id plus granted role names. */
export interface CallerInfo {
  userId: string;
  roles: string[];
}

/**
 * One staged data-plane write (T17b). Mirrors the engine `MutationWrite`
 * (`packages/state/src/mutation/pipeline.ts:37`) minus `when`: stdlib call
 * shapes carry no candidate preconditions, so the seam stages none. The
 * seam validates the wire shape (wiring bugs fail fast) and the pipeline
 * validates every domain rule (unknown model/field, required, refs,
 * uniques, delete modes); nothing is validated twice.
 */
export interface CanonicalStagedWrite {
  readonly transition?: { readonly field: string; readonly from: string; readonly to: string };
  readonly op: 'create' | 'update' | 'remove';
  readonly model: string;
  readonly id: string;
  readonly parent?: RecordParent;
  readonly data?: Record<string, unknown>;
}

/**
 * Unservable-shape policy for {@link CanonicalEffectsScope.readModel}: the
 * shapes `invokeRead` cannot serve in the T17 core scope (T04a carries no
 * filter vocabulary). The seam refuses these LOUD with `validation`
 * instead of mis-serving; the stdlib passes its query through untouched.
 */
export interface CanonicalReadQuery {
  readonly where?: unknown;
  readonly order?: unknown;
  readonly limit?: number;
  readonly archived?: 'exclude' | 'include';
  readonly authority?: 'owner' | 'viewer';
}

/**
 * Canonical execution scope (T17b): the L3 formalization of operation
 * identity plus the engine-backed data-plane closures. Installed ONLY by
 * the canonical scenario seam for the admitted handler run:
 *
 * - `operation`/`operationId` are the admitted scenario identity. Staged
 *   writes carry it into history entries and the fenced commit carries it
 *   into the receipt — one atomic commit per scenario, never one per call.
 * - `stageWrite` runs one write through the canonical mutation pipeline
 *   (real `ModelTable`, provisional map over staged + stored rows) and
 *   stages the resulting domain writes/history/uniques into the
 *   scenario effects. It commits nothing. Returns the staged post-write
 *   row, or `null` for hard removes (which stage no row).
 * - `readModel` serves one whole-model viewer read through `invokeRead`
 *   over the staged overlay (staged writes visible, grants projected by
 *   the engine). Unservable query shapes refuse LOUD (see
 *   {@link CanonicalReadQuery}).
 *
 * Opaque by design: the stdlib never sees the registry, tables, or
 * producers behind these closures, so there is exactly one producer path
 * (the seam in `./invoke.js`) and no second engine or validator.
 */
export interface CanonicalEffectsScope {
  /** Builtin by predicates derived from the live admitted caller/membership. */
  readonly builtinRoles?: readonly string[];
  readonly operation: string;
  readonly operationId: string;
  stageWrite(write: CanonicalStagedWrite): Promise<StoredRow | null>;
  /** Generated language helpers use native record bindings; storage stays wire-valued. */
  createRecord?(model: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  setRecord?(record: Record<string, unknown>, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteRecord?(record: Record<string, unknown>, mode: 'archive' | 'remove'): Promise<void>;
  readModel(model: string, query: CanonicalReadQuery): Promise<ReadonlyArray<ProjectedRecord>>;
  /** Checked source handlers receive native fields from the authorized projection only. */
  readRecords?(model: string, query: CanonicalReadQuery): Promise<ReadonlyArray<Record<string, unknown>>>;
}

/** Formatting facts installed from the checked selected app. */
export interface HandlerFormattingScope {
  /** Checked selected-app metadata; never viewer preferences or business inputs. */
  readonly appDefault: string;
}

/** Handler context threaded as the first argument (`c`) of emitted handlers. */
export interface HandlerContext {
  caller: CallerInfo;
  store: StoragePort;
  clock: () => number;
  memberships: string[];
  preferences: Record<string, Record<string, unknown>>;
  readonly formatting?: HandlerFormattingScope;
  /** Source facts installed only from an admitted canonical context. */
  readonly actor?: UserRef | null;
  /** Current-caller facts for checked actor property reads; never part of a generic user reference. */
  readonly actorFacts?: {
    readonly email: string | undefined;
    readonly email_verified: boolean | undefined;
  } | null;
  readonly team?: { readonly id: string; readonly timezone: string } | null;
  readonly now?: DatetimeValue;
  readonly operation?: { readonly id: string; readonly source: string };
  /**
   * Canonical execution scope (T17b). Present inside canonical scenario
   * execution only; the migrated stdlib data plane requires it and fails
   * loud without it (the direct-commit paths were retired in T17).
   */
  readonly canonical?: CanonicalEffectsScope;
  /** Checked bound send staging; installed by the canonical seam, never commits. */
  readonly sendDeferred?: (operation: string, request: unknown, binding: string) => Promise<DeliveryRef>;
}

/**
 * Dependencies for {@link createContext}. `clock`/`memberships`/
 * `preferences` default. `preferences` keys are app names; pages read
 * `c.preferences.<App>.<key>` — defaulting an app key the page reads is
 * the caller's job (authoring defaults live in the Given block; the
 * dispatcher join must supply them, B1 callers pass them explicitly).
 * `canonical` is install-only (the scenario seam supplies it); callers
 * outside canonical execution omit it.
 */
export interface CreateContextDeps {
  caller: CallerInfo;
  store: StoragePort;
  clock?: () => number;
  memberships?: string[];
  preferences?: Record<string, Record<string, unknown>>;
  canonical?: CanonicalEffectsScope;
  sendDeferred?: HandlerContext['sendDeferred'];
  /** Internal admitted facts; business inputs and caller labels cannot supply these. */
  qualified?: InvocationContext;
  /** Internal checked selected-app formatting facts. No context-level defaults. */
  formatting?: HandlerFormattingScope;
}

/**
 * Build a handler context. Defaults: `clock` is `Date.now`,
 * `memberships` is `[]`, `preferences` is `{}`. `canonical` passes
 * through only when supplied (no `canonical: undefined` key otherwise,
 * so field-level equality keeps its exact shape).
 */
export function createContext(deps: CreateContextDeps): HandlerContext {
  return {
    caller: deps.caller,
    store: deps.store,
    clock: deps.clock ?? (() => Date.now()),
    memberships: deps.memberships ?? [],
    preferences: deps.preferences ?? {},
    ...(deps.formatting === undefined ? {} : {
      formatting: Object.freeze({ appDefault: deps.formatting.appDefault }),
    }),
    ...(deps.canonical === undefined ? {} : { canonical: deps.canonical }),
    ...(deps.sendDeferred === undefined ? {} : { sendDeferred: deps.sendDeferred }),
    ...(deps.qualified === undefined ? {} : {
      actor: deps.qualified.actor === null ? null : makeUserRef(deps.qualified.actor.userId),
      actorFacts: deps.qualified.actor === null ? null : Object.freeze({
        email: deps.qualified.actor.email,
        email_verified: deps.qualified.actor.emailVerified,
      }),
      team: deps.qualified.team === null ? null : Object.freeze({ id: deps.qualified.team.teamId, timezone: deps.qualified.team.timezone }),
      now: makeDatetime(BigInt(deps.qualified.now)),
      operation: Object.freeze({ id: deps.qualified.operationId, source: deps.qualified.source }),
    }),
  };
}
