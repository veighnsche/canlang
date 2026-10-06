# @canlang/work

Durable work kernel: staged outbox intents with an explicit commit gate,
idempotent occurrence admission, keyed and recurring schedules, guarded
dispatch claims, outcome receipts with retry/backoff/reconcile, and
recovery scans. Pure kernel logic plus port interfaces; durable fencing
and storage belong to the lane-3 owner, and the public surface assembles
in `@canlang/stdlib`.

Ownership per `implementation/PLAN.md`: lane 04
(`work/`, `services/`, `files/`) owns this package. Internal only:
`private: true`, no app-facing API.

## Install

Workspace package; no registry install. It resolves inside the monorepo
(from the repository root):

```sh
bun install --frozen-lockfile
```

The root entry and explicit package subpaths load emitted modules.
For example, import `@canlang/work/intent`.

## Usage

Stage an intent, commit it with the fence-produced marker, then dispatch:

```ts
import { attemptDispatch } from '@canlang/work/dispatch';
import { commitOutboxIntent, stageOutboxIntent } from '@canlang/work/intent';
import {
  TestOnlyCounterClaimIds,
  TestOnlyManualClock,
  TestOnlyMemorySupersession,
} from '@canlang/work/ports';

const staged = stageOutboxIntent({
  operationId: 'op_1',
  source: 'billing',
  occurrenceIndex: 0,
  request: { to: 'acme' },
  originOccurrence: null,
});
const committed = commitOutboxIntent(staged, { revision: 1, committedAtMs: 0 });
const outcome = attemptDispatch(
  {
    clock: new TestOnlyManualClock(0),
    claimIds: new TestOnlyCounterClaimIds(),
    supersessions: new TestOnlyMemorySupersession(),
    evaluateGuard: () => true,
  },
  { intent: committed, guard: { predicate: null }, frozenInputs: null, stateSnapshot: null },
);
// outcome: { status: 'claimed', claim: { outboxId, claimId, claimedAt } }
```

Key exports per module:

- `src/intent/index.ts`: `deriveOutboxId`, `freezeRequest`,
  `stageOutboxIntent`, `commitOutboxIntent`, `isCommitted`,
  `requireCommitted`
- `src/event/index.ts`: `admitOccurrence`, `admitCommittedChange`
- `src/schedule/index.ts`: `putSchedule`, `replaceSchedule`,
  `cancelSchedule`, `collectUndispatchedIntents`
- `src/schedule/every.ts`: `admitEveryTick`, `computeEverySlot`,
  `deriveRecurringOccurrenceId`, `everyScopeKey`,
  `RootRecurrenceNotSupportedError`
- `src/dispatch/index.ts`: `attemptDispatch`
- `src/receipt/index.ts`: `classifyFailure`, `recordOutcome`,
  `reconcileUncertain`, `computeBackoff`, `listDeadLetter`,
  `toReceiptObservation`, `DEFAULT_RETRY_POLICY`
- `src/recovery/index.ts`: `buildInventory`, `buildWorkInventory`,
  `scanDueBatch`, `drainDueScan`, `isClaimStale`, `findStaleClaims`,
  `releaseStaleClaims`
- `src/observation/observation.ts`: `observeReceipt`
- `src/observation/association.ts`: `matchAssociatedCompletion`
- `src/ports.ts`, `src/observation/ports.ts`: port interfaces plus
  `TestOnly*` in-memory doubles (tests only, never production)
- `src/kernel/tables.ts`: `KernelTableError`, `WORK_*_MODEL` table names,
  `read*Row` / `new*Row` helpers, query builders
- `src/kernel/commands.ts`: `WORK_SYSTEM_COMMANDS` (nine
  `work.dispatch.*`, `work.occurrence.*`, `work.schedule.*`,
  `work.every.*` fenced system commands)
- `src/catalog.ts`: `workCatalog`, `WORK_CATALOG_VERSION`

## Scripts

From the repository root, after `bun install --frozen-lockfile`:

```sh
bun run build --filter=@canlang/work
bun run --filter @canlang/work typecheck
bun run --filter @canlang/work test
```

The filtered root build schedules this package and its declared producer
dependencies. It emits only each owner’s outputs, cleaning them before execution
or cache restoration. Package `typecheck` and `test` use the same graph, then
run the owning TypeScript check or compiled `node:test` suite uncached. Cross-producer state/work integration proofs run from work’s test suite.
Internal `build:emit`, `typecheck:check`, and `test:unit` tasks are execution
steps; use the public commands above to prepare dependencies.

## Source layout

```text
packages/work/
  package.json          # name @canlang/work, private, build/typecheck/test
  tsconfig.json         # strict, NodeNext, noEmit
  src/
    catalog.ts          # versioned WorkCatalogEntry list
    ports.ts            # store/clock/id ports + TestOnly doubles
    intent/index.ts     # outbox id, frozen request, commit gate
    event/index.ts      # occurrence admission, committed-change handling
    schedule/index.ts   # keyed put/replace/cancel + supersession
    schedule/every.ts   # recurring every() tick admission
    dispatch/index.ts   # guard evaluation + claim issuance
    receipt/index.ts    # outcomes, backoff, reconcile, dead-letter
    recovery/index.ts   # inventory, due scans, claim expiry
    observation/        # receipt projection + association matching
    kernel/             # lane-04 tables + fenced system commands
  test/                 # one *.test.ts per module above
```

## License

No `LICENSE` file exists in this repository; no license pointer applies.
