/**
 * Lane 03 S6 ports fixtures (test worker): scenario invoke wiring over the
 * memory store + membership double, a staging ExecuteHandler with
 * caller-supplied outbox/schedules + domain writes, PO-box helpers, and a
 * read world reusing the query policy builders. Builders only: no assertions.
 *
 * Reuses the mutation invoke wiring and query policy builders read-only;
 * nothing here invents engine APIs.
 */
import type { Team } from '@canlang/contracts';
import type {
  ModelName,
  OperationName,
  OutboxIntent,
  Receipt,
  ScheduleOp,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { MutationResult } from '@canlang/contracts';
import { invoke } from '../../src/invocation/invoke.js';
import type { ExecuteHandler } from '../../src/invocation/invoke.js';
import { receiptIdentityFor } from '../../src/invocation/admission.js';
import { buildContext } from '../../src/invocation/context.js';
import type { OperationRegistry } from '../../src/invocation/registry.js';
import { createTestMemoryStorage } from '../../src/storage/memory.js';
import type { MemoryStoreProbe } from '../../src/storage/memory.js';
import type { PolicyTable } from '../../src/policy/grants.js';
import {
  APP,
  asId,
  asModel,
  asOperation,
  freshOperationId,
  freshRecordId,
  identityFor,
} from '../mutation/fixtures.js';
import {
  FIXED_NOW,
  captureStateError,
  createMemoryIdentityStore,
  makeDef,
  makeEnvelope,
  makeRow,
  seedMember,
} from '../invocation/fixtures.js';
import type { SeededMember, TestMembershipStore } from '../invocation/fixtures.js';
import {
  grant,
  modelPolicy,
  policyTable,
  seedRows,
  seedStandardTeam,
} from '../query/fixtures.js';

export { APP, FIXED_NOW, asId, asModel, asOperation, captureStateError };
export { freshOperationId, freshRecordId, grant, identityFor, modelPolicy, policyTable };
export { seedRows, seedStandardTeam };
export type { PolicyTable, SeededMember, TestMembershipStore };

/** Scenario operation served by the staging handler. */
export const STAGE_OP = 'Acme.stage';

/** Domain model for staged writes. */
export const WIDGET_MODEL = 'Acme.Widget';

/** Domain model for read-port rows. */
export const DOC_MODEL = 'Acme.Doc';

/* -- Ports world: invoke wiring for the staging handler. -- */

export interface PortsWorld {
  readonly store: StoragePort;
  readonly probe: MemoryStoreProbe;
  readonly memberships: TestMembershipStore;
  readonly team: Team;
  readonly alice: SeededMember;
  readonly registry: OperationRegistry;
  readonly model: ModelName;
}

/** One isolated world: memory store, one member, the stage registry. */
export async function setupPortsWorld(): Promise<PortsWorld> {
  const { store, probe } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const registry: OperationRegistry = new Map([
    [STAGE_OP, makeDef({ name: asOperation(STAGE_OP) })],
  ]);
  return { store, probe, memberships, team: alice.team, alice, registry, model: asModel(WIDGET_MODEL) };
}

export interface StageCallOpts {
  readonly operationId?: string;
  readonly inputs?: Record<string, unknown>;
  readonly member?: SeededMember;
  readonly execute: ExecuteHandler;
}

/** One scenario invoke over the world (frozen clock, `test` source). */
export async function invokeStage(
  world: PortsWorld,
  opts: StageCallOpts,
): Promise<MutationResult> {
  const member = opts.member ?? world.alice;
  return invoke({
    registry: world.registry,
    envelope: makeEnvelope(STAGE_OP, opts.operationId ?? freshOperationId(), opts.inputs ?? {}),
    identity: identityFor(member),
    app: APP,
    source: 'test',
    store: world.store,
    memberships: world.memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute: opts.execute,
  });
}

/** Read the receipt for one stage call (same identity mapping as invoke). */
export async function readStageReceipt(
  world: PortsWorld,
  operationId: string,
  member?: SeededMember,
): Promise<Receipt | null> {
  const ctx = buildContext({
    identity: identityFor(member ?? world.alice),
    operation: asOperation(STAGE_OP),
    operationId,
    app: APP,
    source: 'test',
    now: FIXED_NOW,
  });
  return world.store.readReceipt(receiptIdentityFor(ctx));
}

/* -- Staging handler: caller-supplied outbox/schedules + domain writes. -- */

/** One staged intent minus `operationId`, filled from the live call. */
export interface StagedIntentInput {
  readonly intentId: string;
  readonly operation: string;
  readonly target: string;
  readonly arguments: Record<string, unknown>;
  readonly occurrenceIndex: number;
  readonly dispatchGuard?: string;
}

export interface StagingHandlerOpts {
  /** Row inserted by the handler when present. */
  readonly row?: StoredRow;
  readonly model?: ModelName;
  readonly intents?: ReadonlyArray<StagedIntentInput>;
  readonly schedules?: ReadonlyArray<ScheduleOp>;
  readonly result?: unknown;
}

/**
 * Scenario handler staging exactly what the caller supplies. Intent
 * `operationId` always equals the invoking operation (staging forbids
 * cross-operation intents); malformed values pass through for the engine
 * to reject — the handler never validates.
 */
export function makeStagingHandler(opts: StagingHandlerOpts = {}): ExecuteHandler {
  return async (call) => ({
    writes:
      opts.row === undefined
        ? []
        : [
            {
              kind: 'insert' as const,
              model: opts.model ?? asModel(WIDGET_MODEL),
              row: opts.row,
            },
          ],
    history: [],
    outbox: (opts.intents ?? []).map(
      (intent): OutboxIntent => ({
        intentId: intent.intentId,
        operation: intent.operation as OperationName,
        operationId: call.context.operationId,
        target: intent.target,
        arguments: intent.arguments,
        occurrenceIndex: intent.occurrenceIndex,
        ...(intent.dispatchGuard !== undefined ? { dispatchGuard: intent.dispatchGuard } : {}),
      }),
    ),
    schedules: [...(opts.schedules ?? [])],
    uniqueClaims: [],
    uniqueReleases: [],
    resolvedDefaults: {},
    result: opts.result ?? { ok: true },
  });
}

/** One widget row for staged domain writes. */
export function makeWidgetRow(id?: string, data?: Record<string, unknown>): StoredRow {
  return makeRow({
    id: id ?? freshRecordId('widget'),
    ...(data !== undefined ? { data } : {}),
  });
}

/** One staged intent input (operationId filled at invoke time). */
export function makeStagedIntent(
  intentId?: string,
  overrides: Partial<StagedIntentInput> = {},
): StagedIntentInput {
  return {
    intentId: intentId ?? `intent-${freshRecordId('ob').replace('ob-', '')}`,
    operation: STAGE_OP,
    target: 'mail.send',
    arguments: { to: 'a@example.com' },
    occurrenceIndex: 0,
    ...overrides,
  };
}

/* -- PO-box helpers over the port readers. -- */

/** Pending outbox intents via the storage reader. */
export async function pendingOutbox(store: StoragePort): Promise<ReadonlyArray<OutboxIntent>> {
  return store.outboxPending();
}

/** Pending intent ids in reader order. */
export async function pendingIntentIds(store: StoragePort): Promise<string[]> {
  return (await store.outboxPending()).map((intent) => intent.intentId);
}

/* -- Read world: standard team + store for read-port delegation. -- */

export interface ReadWorld {
  readonly store: StoragePort;
  readonly memberships: TestMembershipStore;
  readonly team: Team;
  /** Ordinary active member, no declared roles. */
  readonly alice: SeededMember;
  /** Team owner, no declared roles. */
  readonly owner: SeededMember;
  readonly model: ModelName;
}

/** One isolated read world: memory store, standard team, doc model. */
export async function setupReadWorld(): Promise<ReadWorld> {
  const { store } = createTestMemoryStorage();
  const team = await seedStandardTeam();
  return {
    store,
    memberships: team.memberships,
    team: team.team,
    alice: team.alice,
    owner: team.owner,
    model: asModel(DOC_MODEL),
  };
}
