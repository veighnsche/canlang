/**
 * Lane 03 S6: fail-closed validation for fenced outbox/schedule staging.
 *
 * Every failure below is a `StateError` validation — deterministic and
 * replayable as rejected receipts. Staging deep-clones valid input and
 * rebuilds fresh objects (unknown extra keys are dropped, never passed
 * through), so staged effects are engine-owned and adapter-safe.
 *
 * S6 DECISIONS (final, documented inline at each site):
 * - Intent `operationId` MUST equal the invoking operation: cross-operation
 *   staging is forbidden interim (intents belong to their operation).
 * - Intent ids are unique within one batch; duplicates are validation errors.
 * - Duplicate schedule keys in one batch are ALLOWED and apply in array
 *   order: last op for a key wins at the store (VERIFIED: the memory
 *   adapter loops the batch sequentially, set/delete per op).
 * - Schedule `at` is a finite number >= 0; past times are allowed (the
 *   scheduler fires overdue entries).
 */

import type {
  ModelName,
  OperationId,
  OperationName,
  OutboxIntent,
  RecordId,
  StoredRow,
  ScheduleOp,
  UniqueClaim,
  UniqueRelease,
} from '@canlang/contracts';
import { canonicalUniqueScopeValue } from '../internal/unique-value.js';
import type { ModelTable } from '../mutation/models.js';
import { decodeValue } from '@canlang/values';
import { StateError } from '../errors.js';
import { checkJsonSafe, jsonClone } from '../internal/json.js';

/** Max length for staged intent ids, schedule keys, and run identities. */
export const STAGING_MAX_ID_LENGTH = 128;

/**
 * Recommended deterministic intent-id builder:
 * `${operationId}#${occurrenceIndex}`. The id format itself is free-form —
 * only non-emptiness and the length bound are enforced.
 */
export function outboxIntentId(operationId: string, occurrenceIndex: number): string {
  return `${operationId}#${occurrenceIndex}`;
}

/** Staging context: the invoking operation's identity. */
export interface StagingContext {
  readonly operationId: string;
}

/** Non-empty string within the staging id bound. */
function checkIdString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new StateError('validation', `${what} must be a non-empty string.`);
  }
  if (value.length > STAGING_MAX_ID_LENGTH) {
    throw new StateError(
      'validation',
      `${what} must be at most ${STAGING_MAX_ID_LENGTH} characters.`,
    );
  }
  return value;
}

/** Non-empty string with no length bound (operation/target/event names). */
function checkNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new StateError('validation', `${what} must be a non-empty string.`);
  }
  return value;
}

/** Plain data object: arrays and null are rejected, never coerced. */
function checkPlainObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StateError('validation', `${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validate and deep-clone one batch of outbox intents. Per intent: `intentId`
 * non-empty within the bound, `operation`/`target` non-empty,
 * `arguments` a plain JSON-safe object, `occurrenceIndex` an integer >= 0,
 * `dispatchGuard` non-empty when present. The intent `operationId` MUST
 * equal `ctx.operationId` (cross-operation staging forbidden interim), and
 * intent ids must be unique within the batch.
 */
export function stageOutboxIntents(
  intents: ReadonlyArray<OutboxIntent>,
  ctx: StagingContext,
): OutboxIntent[] {
  if (!Array.isArray(intents)) {
    throw new StateError('validation', 'Staged outbox must be an array.');
  }
  if (typeof ctx?.operationId !== 'string' || ctx.operationId === '') {
    throw new StateError('validation', 'Staging needs a non-empty operation identity.');
  }
  const seen = new Set<string>();
  const staged: OutboxIntent[] = [];
  for (const intent of intents) {
    if (typeof intent !== 'object' || intent === null || Array.isArray(intent)) {
      throw new StateError('validation', 'Staged outbox intents must be objects.');
    }
    const candidate = intent as Readonly<Record<string, unknown>>;
    const intentId = checkIdString(candidate['intentId'], 'Outbox intent id');
    const operation = checkNonEmptyString(candidate['operation'], 'Outbox intent operation');
    if (candidate['operationId'] !== ctx.operationId) {
      throw new StateError(
        'validation',
        'Outbox intents belong to the invoking operation; cross-operation staging is forbidden.',
      );
    }
    const target = checkNonEmptyString(candidate['target'], 'Outbox intent target');
    const clonedArgs = jsonClone(
      checkPlainObject(candidate['arguments'], 'Outbox intent arguments'),
      'Outbox intent arguments',
    );
    checkJsonSafe(clonedArgs, 'Outbox intent arguments');
    const occurrenceIndex = candidate['occurrenceIndex'];
    if (
      typeof occurrenceIndex !== 'number' ||
      !Number.isInteger(occurrenceIndex) ||
      occurrenceIndex < 0
    ) {
      throw new StateError('validation', 'Outbox occurrence index must be an integer >= 0.');
    }
    const rawGuard = candidate['dispatchGuard'];
    let dispatchGuard: string | undefined;
    if (rawGuard === undefined) {
      dispatchGuard = undefined;
    } else if (typeof rawGuard === 'string' && rawGuard !== '') {
      dispatchGuard = rawGuard;
    } else {
      throw new StateError('validation', 'Outbox dispatch guard must be a non-empty string.');
    }
    if (seen.has(intentId)) {
      throw new StateError('validation', `Duplicate outbox intent id ${JSON.stringify(intentId)}.`);
    }
    seen.add(intentId);
    staged.push({
      intentId,
      operation: operation as OperationName,
      operationId: ctx.operationId as OperationId,
      target,
      arguments: clonedArgs,
      occurrenceIndex,
      ...(dispatchGuard !== undefined ? { dispatchGuard } : {}),
    });
  }
  return staged;
}

/**
 * Validate and deep-clone one batch of schedule ops. Replace ops carry a
 * bounded non-empty key, a finite `at` >= 0 (past allowed: the scheduler
 * fires overdue entries), a non-empty event, and a plain JSON-safe payload;
 * cancel ops carry a bounded non-empty key. Duplicate keys in one batch are
 * allowed and apply in array order (last op for a key wins at the store).
 */
export function stageScheduleOps(ops: ReadonlyArray<ScheduleOp>): ScheduleOp[] {
  if (!Array.isArray(ops)) {
    throw new StateError('validation', 'Staged schedules must be an array.');
  }
  const staged: ScheduleOp[] = [];
  for (const op of ops) {
    if (typeof op !== 'object' || op === null || Array.isArray(op)) {
      throw new StateError('validation', 'Staged schedule ops must be objects.');
    }
    const candidate = op as Readonly<Record<string, unknown>>;
    if (candidate['op'] === 'replace') {
      const key = checkIdString(candidate['key'], 'Schedule key');
      const at = candidate['at'];
      if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
        throw new StateError('validation', 'Schedule time must be a finite number >= 0.');
      }
      const event = checkNonEmptyString(candidate['event'], 'Schedule event');
      const clonedPayload = jsonClone(
        checkPlainObject(candidate['payload'], 'Schedule payload'),
        'Schedule payload',
      );
      checkJsonSafe(clonedPayload, 'Schedule payload');
      staged.push({ op: 'replace', key, at, event: event as OperationName, payload: clonedPayload });
    } else if (candidate['op'] === 'cancel') {
      const key = checkIdString(candidate['key'], 'Schedule key');
      staged.push({ op: 'cancel', key });
    } else {
      throw new StateError('validation', 'Schedule ops must be replace or cancel.');
    }
  }
  return staged;
}

/**
 * T24a: which operation/effect produced one staged intent, read back off
 * the validated shape. The five fields restate the origin the fence
 * carries (operation identity, declaring target, deterministic
 * occurrence index, dispatch-guard reference); lane 4 joins its claim
 * lifecycle rows onto `intentId` plus this origin.
 */
export interface StagedIntentOrigin {
  readonly intentId: string;
  readonly operation: OperationName;
  readonly operationId: OperationId;
  readonly target: string;
  readonly occurrenceIndex: number;
  readonly dispatchGuard: string | null;
}

/**
 * T24a: validate one intent-shaped value EXACTLY like batch staging and
 * return its origin. Used by join assertions and T24b producers to name
 * the producer identically; duplicates are a batch-level concern and
 * are NOT checked here (see `stageDispatchJoin`).
 */
export function describeIntentOrigin(intent: OutboxIntent, ctx: StagingContext): StagedIntentOrigin {
  const staged = stageOutboxIntents([intent], ctx);
  const first = staged[0];
  if (first === undefined) {
    throw new StateError('validation', 'Staged outbox must be an array.');
  }
  return {
    intentId: first.intentId,
    operation: first.operation,
    operationId: first.operationId,
    target: first.target,
    occurrenceIndex: first.occurrenceIndex,
    dispatchGuard: first.dispatchGuard ?? null,
  };
}

/** T24a: one intent carrying a `when` guard for stage-time evaluation. */
export interface JoinGuardRef {
  readonly intentId: string;
  readonly guard: string;
}

/**
 * T24a: the staged dispatch join — validated intents plus their origins
 * and guard refs, all owned by ONE triggering operation.
 *
 * SINGLE-OWNER SCOPE ONLY: every intent's `operationId` equals the one
 * invoking operation (enforced by `stageOutboxIntents`), and the join
 * commits in that owner's fence revision. Cross-store atomicity is NOT
 * claimed and MUST NOT be inferred: each owner store commits its own
 * fence; there is no two-phase commit across owners.
 */
export interface StagedDispatchJoin {
  readonly intents: OutboxIntent[];
  readonly origins: StagedIntentOrigin[];
  /**
   * Intents carrying a `when` guard. Stage-time verdicts are evaluated
   * lane-04-side against the producer snapshot and pinned on the
   * dispatch row in the same batch; the claim-time re-check stays the
   * dispatch fence.
   */
  readonly guards: JoinGuardRef[];
  /** The single owning operation of the whole join batch. */
  readonly operationId: string;
}

/**
 * T24a: validate one batch of dispatch-join intents (delegating to
 * `stageOutboxIntents` — identical rules, no behavior change) and
 * derive the origins plus guard refs the join carries. Empty batches
 * pass trivially (ordinary trigger batches stage no dispatch work).
 */
export function stageDispatchJoin(
  intents: ReadonlyArray<OutboxIntent>,
  ctx: StagingContext,
): StagedDispatchJoin {
  const staged = stageOutboxIntents(intents, ctx);
  const origins: StagedIntentOrigin[] = staged.map((intent) => ({
    intentId: intent.intentId,
    operation: intent.operation,
    operationId: intent.operationId,
    target: intent.target,
    occurrenceIndex: intent.occurrenceIndex,
    dispatchGuard: intent.dispatchGuard ?? null,
  }));
  const guards: JoinGuardRef[] = [];
  for (const intent of staged) {
    if (intent.dispatchGuard !== undefined) {
      guards.push({ intentId: intent.intentId, guard: intent.dispatchGuard });
    }
  }
  return { intents: staged, origins, guards, operationId: ctx.operationId };
}

/**
 * T34-F5: validate one frozen fanout identity set — an array of
 * non-empty canonical record ids with no duplicates — and return it in
 * sorted canonical order. Duplicates fail closed (a frozen set with a
 * duplicate is store disagreement, never silently deduped at commit).
 */
export function stageFanoutMembership(members: ReadonlyArray<string>, what: string): string[] {
  if (!Array.isArray(members)) {
    throw new StateError('validation', `${what} must be an array of canonical record ids.`);
  }
  const seen = new Set<string>();
  for (const entry of members) {
    if (typeof entry !== 'string' || entry === '') {
      throw new StateError('validation', `${what} entries must be non-empty strings.`);
    }
    if (seen.has(entry)) {
      throw new StateError(
        'validation',
        `${what} contains a duplicate identity: ${JSON.stringify(entry)}.`,
      );
    }
    seen.add(entry);
  }
  return [...seen].sort();
}

/** T34-F5: closed terminal child-outcome fields for one child record. */
export interface StagedFanoutChildOutcome {
  readonly state: 'completed' | 'skipped' | 'failed';
  readonly causeKind: 'completed' | 'skipped' | 'failed';
  readonly causeReason: string | null;
  readonly attempts: number;
}

/**
 * T34-F5: validate one terminal child-outcome staging — closed
 * state/cause pairing (completed carries no reason; skipped carries
 * deleted/non-applicable; failed carries a closed failed reason) plus
 * an attempts count. Non-terminal states and open causes fail closed;
 * unknown extra keys are dropped by the caller, never passed through.
 */
type FanoutChildOutcomeInput = {
  readonly state: string;
  readonly causeKind: string | null;
  readonly causeReason: string | null;
  readonly attempts: number;
};

/** Completed carries kind completed with no reason. */
function completedFanoutChildOutcome(input: FanoutChildOutcomeInput,
  attempts: number): StagedFanoutChildOutcome | undefined {
  if (input.state !== 'completed') return undefined;
  if (input.causeKind !== 'completed' || input.causeReason !== null) {
    throw new StateError(
      'validation',
      'Fanout completed outcome must carry kind completed with no reason.',
    );
  }
  return { state: 'completed', causeKind: 'completed', causeReason: null, attempts };
}

/** Skipped carries a closed deleted/non-applicable reason. */
function skippedFanoutChildOutcome(input: FanoutChildOutcomeInput,
  attempts: number): StagedFanoutChildOutcome | undefined {
  if (input.state !== 'skipped') return undefined;
  if (
    input.causeKind !== 'skipped' ||
    (input.causeReason !== 'deleted' && input.causeReason !== 'non-applicable')
  ) {
    throw new StateError(
      'validation',
      `Fanout skipped outcome needs a closed reason, got ${JSON.stringify(input.causeReason)}.`,
    );
  }
  return { state: 'skipped', causeKind: 'skipped', causeReason: input.causeReason, attempts };
}

/** Failed carries a closed failed reason. */
function failedFanoutChildOutcome(input: FanoutChildOutcomeInput,
  attempts: number): StagedFanoutChildOutcome | undefined {
  if (input.state !== 'failed') return undefined;
  if (
    input.causeKind !== 'failed' ||
    (input.causeReason !== 'business-rejection' &&
      input.causeReason !== 'terminal' &&
      input.causeReason !== 'exhausted' &&
      input.causeReason !== 'missing-record' &&
      input.causeReason !== 'inaccessible-record' &&
      input.causeReason !== 'infra-read-failure')
  ) {
    throw new StateError(
      'validation',
      `Fanout failed outcome needs a closed reason, got ${JSON.stringify(input.causeReason)}.`,
    );
  }
  return { state: 'failed', causeKind: 'failed', causeReason: input.causeReason, attempts };
}

export function stageFanoutChildOutcome(input: {
  readonly state: string;
  readonly causeKind: string | null;
  readonly causeReason: string | null;
  readonly attempts: number;
}): StagedFanoutChildOutcome {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new StateError('validation', 'Fanout child outcome must be an object.');
  }
  const attempts = input.attempts;
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new StateError('validation', 'Fanout child attempts must be an integer >= 0.');
  }
  const staged = completedFanoutChildOutcome(input, attempts) ??
    skippedFanoutChildOutcome(input, attempts) ??
    failedFanoutChildOutcome(input, attempts);
  if (staged === undefined) {
    throw new StateError(
      'validation',
      `Fanout child outcome state must be terminal, got ${JSON.stringify(input.state)}.`,
    );
  }
  return staged;
}

/**
 * BGI-08 `state.unique-key@1` computed-key producer join. State owns this
 * join: checked old/final text keys feed canonical releases/claims and the
 * single fenced commit. The saved generated export computes one key from a
 * projected text input and returns checked text; it receives no record
 * handles, no store, no registry and no commit authority, and it chooses
 * no claim namespace — the claim key name below is State-owned, derived
 * from the compiler-owned rule identity, and can never collide with a
 * builtin unique key name (builtin names are bare field names or
 * comma-joined pairs; every computed name carries the rule's dots).
 */

/** BGI-08 one checked computed-key rule as the pipeline consumes it. */
export interface GivenUniqueKeyRule {
  /** Compiler-owned rule identity (`Owner.Model.field#keyword`). */
  readonly rule: string;
  /** Bound text field name. */
  readonly field: string;
  /**
   * Saved generated export: pure text in, text out. State projects the
   * exact input and checks the exact result with the Values text codec;
   * the export observes no rows, no store and no commit.
   */
  readonly evaluate: (value: string) => string | Promise<string>;
}

/** Pure checks observe only a required normalized text value. */
export interface GivenFieldValidationRule {
  readonly rule: string;
  readonly field: string;
  readonly evaluate: (value: string) => boolean | Promise<boolean>;
}

/** Shared by canonical writes, staged-schema validation and isolated fixtures. */
export async function validateGivenFields(
  rules: ReadonlyArray<GivenFieldValidationRule>,
  data: Readonly<Record<string, unknown>>,
  consumeWork?: () => void,
): Promise<void> {
  for (const rule of rules) {
    consumeWork?.();
    const input = Object.getOwnPropertyDescriptor(data, rule.field);
    const invalid = (): StateError => new StateError('validation', `Invalid field ${JSON.stringify(rule.field)}: generated field validation failed.`);
    if (input === undefined || !('value' in input) || typeof input.value !== 'string') throw invalid();
    let result: unknown;
    try { result = await rule.evaluate(input.value); }
    catch { throw invalid(); }
    if (result !== true) throw invalid();
  }
}

/** BGI-08 State-owned claim namespace for one computed-key rule. */
export function givenUniqueKeyName(rule: string): string {
  return `given:${rule}`;
}

/**
 * BGI-08 evaluation scope: the active-call/closed-scope/failure discipline
 * for computed-key evaluation. One scope spans one pipeline run: at most
 * one in-flight evaluation (overlapping calls fail), evaluation after
 * `close()` fails as a late call, and the first canonical failure is
 * retained — later evaluations rethrow it without rerunning generated
 * behavior. The pipeline awaits evaluations sequentially, so overlap can
 * only arise from direct misuse; the guard is explicit either way.
 */
export interface GivenUniqueKeyScope {
  /**
   * Evaluate one bound field value: null/undefined projects to no key
   * (mirroring builtin unique skips); any other value must decode as
   * exact text and the saved export must return exact text.
   */
  evaluate(rule: GivenUniqueKeyRule, value: unknown): Promise<string | null>;
  /** Close the scope: the pipeline run donated its staging; late calls fail. */
  close(): void;
}

export function createGivenUniqueKeyScope(): GivenUniqueKeyScope {
  let closed = false;
  let active = 0;
  let failed: StateError | null = null;
  const invalid = (message: string): StateError => new StateError('validation', message);
  return {
    async evaluate(rule: GivenUniqueKeyRule, value: unknown): Promise<string | null> {
      const where = `Computed-key rule ${JSON.stringify(rule.rule)}`;
      if (closed) throw invalid(`${where} evaluated after its staging scope closed (late call).`);
      if (failed !== null) throw failed;
      if (active !== 0) throw invalid(`${where} overlaps an in-flight evaluation.`);
      if (value === null || value === undefined) return null;
      active += 1;
      try {
        let projected: string;
        try {
          const decoded = decodeValue('text', value);
          if (typeof decoded !== 'string') throw invalid(`${where} input must be text.`);
          projected = decoded;
        } catch (error) {
          if (error instanceof StateError) throw error;
          throw invalid(`${where} input must be text.`);
        }
        let result: unknown;
        try {
          result = await rule.evaluate(projected);
        } catch (error) {
          if (error instanceof StateError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          throw invalid(`${where} saved export failed: ${message}`);
        }
        try {
          const checked = decodeValue('text', result);
          if (typeof checked !== 'string') throw invalid(`${where} result must be text.`);
          return checked;
        } catch (error) {
          if (error instanceof StateError) throw error;
          throw invalid(`${where} result must be text.`);
        }
      } catch (error) {
        if (failed === null) failed = error instanceof StateError ? error : invalid(String(error));
        throw failed;
      } finally {
        active -= 1;
      }
    },
    close(): void {
      closed = true;
    },
  };
}

/** BGI-08 net computed touches for one row transition. */
export interface GivenUniqueKeyDiff {
  readonly claims: UniqueClaim[];
  readonly releases: UniqueRelease[];
}

/**
 * BGI-08 diff old/final keys for one row: evaluates the bound field from
 * each present side in rule order (sequential, deterministic), skips
 * unchanged keys, and returns canonical claims/releases with State-owned
 * key names. A null side means the row is absent there (create/remove);
 * callers pass the pipeline's hook-adjusted rows so staged reads and the
 * staged keys observe the same values.
 */
export async function diffGivenUniqueKeys(
  scope: GivenUniqueKeyScope,
  rules: ReadonlyArray<GivenUniqueKeyRule>,
  model: ModelName,
  recordId: RecordId,
  before: Readonly<Record<string, unknown>> | null,
  after: Readonly<Record<string, unknown>> | null,
): Promise<GivenUniqueKeyDiff> {
  const claims: UniqueClaim[] = [];
  const releases: UniqueRelease[] = [];
  for (const rule of rules) {
    const keyName = givenUniqueKeyName(rule.rule);
    const oldKey = before === null ? null : await scope.evaluate(rule, before[rule.field]);
    const newKey = after === null ? null : await scope.evaluate(rule, after[rule.field]);
    if (oldKey === newKey) continue;
    if (oldKey !== null) releases.push({ model, keyName, keyValue: oldKey });
    if (newKey !== null) claims.push({ model, keyName, keyValue: newKey, recordId });
  }
  return { claims, releases };
}

/** BGI-08 one installed row for installation/activation planning. */
export interface GivenUniqueKeyInstallRow extends Pick<StoredRow, 'parent'> {
  readonly model: ModelName;
  readonly id: RecordId;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * BGI-08 installation/changed-code activation planner: evaluates every
 * installed row's final key under the given rules and returns the canonical
 * claims to commit through the standard fenced commit (the same claim path
 * existing schema evolution uses, so store enforcement is shared). Rows
 * colliding within the plan fail here as `conflict` before anything
 * commits — mirroring activation's validate-before-flip — while collisions
 * against already-committed claims surface at the fenced commit. The
 * planner mutates nothing: a failed activation retains the prior
 * schema/claims trivially. Callers planning changed code pass the NEW
 * saved export as the rules' evaluator; a fingerprint mismatch between the
 * checked binding and the resolved module must refuse before planning.
 * Contained rows require the checked model table and actual stored parent;
 * the pure saved export never selects its uniqueness scope.
 */
export async function planGivenUniqueKeyInstall(
  rulesByModel: ReadonlyMap<ModelName, ReadonlyArray<GivenUniqueKeyRule>>,
  rows: ReadonlyArray<GivenUniqueKeyInstallRow>,
  models?: ModelTable,
): Promise<{ readonly claims: UniqueClaim[] }> {
  const scope = createGivenUniqueKeyScope();
  try {
    const claims: UniqueClaim[] = [];
    const seen = new Map<string, GivenUniqueKeyInstallRow>();
    for (const row of rows) {
      const rules = rulesByModel.get(row.model) ?? [];
      for (const rule of rules) {
        const definition = models?.get(row.model);
        if (models !== undefined && definition === undefined || models === undefined && row.parent != null) {
          throw new StateError('validation', 'Computed-key installation needs its checked model ownership table.');
        }
        const evaluated = await scope.evaluate(rule, row.data[rule.field]);
        const key = definition === undefined ? evaluated : canonicalUniqueScopeValue(row, evaluated, definition);
        if (key === null) continue;
        const identity = JSON.stringify([row.model, givenUniqueKeyName(rule.rule), key]);
        const first = seen.get(identity);
        if (first !== undefined) {
          throw new StateError(
            'conflict',
            `Computed-key rule ${JSON.stringify(rule.rule)} collides on installed rows ` +
              `${JSON.stringify(first.id as string)} and ${JSON.stringify(row.id as string)}.`,
          );
        }
        seen.set(identity, row);
        claims.push({
          model: row.model,
          keyName: givenUniqueKeyName(rule.rule),
          keyValue: key,
          recordId: row.id,
        });
      }
    }
    return { claims };
  } finally {
    scope.close();
  }
}

/**
 * Validate ExecutionEffects-shaped staging (`{ outbox, schedules }`).
 * `crudExecute`'s empty arrays pass trivially.
 */
export function stageEffectsStaging(
  effects: {
    readonly outbox: ReadonlyArray<OutboxIntent>;
    readonly schedules: ReadonlyArray<ScheduleOp>;
  },
  ctx: StagingContext,
): { readonly outbox: OutboxIntent[]; readonly schedules: ScheduleOp[] } {
  if (typeof effects !== 'object' || effects === null || Array.isArray(effects)) {
    throw new StateError('validation', 'Staged effects must be an object.');
  }
  return {
    outbox: stageOutboxIntents(effects.outbox, ctx),
    schedules: stageScheduleOps(effects.schedules),
  };
}
