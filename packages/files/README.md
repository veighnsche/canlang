# @canlang/files

File upload intake, finalization, provenance, retention, and host bridge
for CanLang. Request/event provenance is bound at finalization and frozen
afterwards; every byte and metadata read re-verifies the caller against
the bound owner and fails closed. Internal package; the public surface
assembles in `@canlang/stdlib`.

Ownership per `implementation/PLAN.md`: lane 04
(`prompts/04-work-services-files.md`) owns the file lifecycle. There is
a root entry and explicit exported subpaths; import the capability you need.

## Install

Private bun workspace member. From the repo root:

```sh
bun install --frozen-lockfile
```

## Usage

Host routing with the bridge (dependency-light example):

```ts
import { createBridgeOrigin, routeHost } from '@canlang/files/bridge';

const origin = createBridgeOrigin('https://app.example');
if (origin === null) throw new Error('bad origin');
const route = routeHost(origin, { name: 'host', fileTransferVersions: [1] });
// { action: 'bridge-v1',
//   meta: { version: 1, intents: 'https://app.example/files/intents' } }
```

Key exports by module:

- `src/upload/index.ts`: `createUploadIntent`, `appendUploadContent`,
  `appendUploadContentAtOffset`,
  `completeUploadContent`, `DEFAULT_FILE_POLICY`, `detectContentType`,
  `checkContent`, `sha256Hex`, `stagingKeyForIntent`
- `src/upload/fs-blob-store.ts`: `createFsBlobStore`
- `src/finalize/index.ts`: `finalizeUpload`, `ingestVerifiedEventBytes`,
  `authorizeAttach`, `recordAttachment`, `readFinalizedBytes`,
  `readFinalizedFile`, `storedState`, `blobKeyForFile`
- `src/provenance/index.ts`: `bindRequestProvenance`,
  `validateEventProvenance`, `freezeFinalized`, `isSameReceiver`,
  `requestProvenanceMatches`
- `src/retention/index.ts`: `runRetention`, `describeForReceipt`
- `src/bridge.ts`: `createBridgeOrigin`, `intentsUrlFor`,
  `advertiseFileTransfer`, `routeHost`, `handleCreateIntent`,
  `handleAppend`, `handleAppendAtOffset`, `handleComplete`, `handleFinalize`,
  `FILE_TRANSFER_META_KEY`
- `src/ports.ts`: `assertSafeBlobKey` plus the `TestOnly*` doubles
  (`TestOnlyManualClock`, `TestOnlyMemoryBlobStore`,
  `TestOnlyMemoryIntentStore`, `TestOnlyMemoryFinalizedStore`,
  `TestOnlyCounterIntentIds`, `TestOnlyCounterFileIds`,
  `TestOnlyFixedPrincipal`)
- `src/catalog.ts`: `filesCatalog`, `FILES_CATALOG_VERSION`
- `src/scenarios.ts`: `FILES_SCENARIO_TABLES` (pinned empty, by design)
- `src/host/sqlite.ts`: `createSqliteFileStore`, `createSqliteFileBindings`
  (explicit Node host; metadata and bytes share one transaction)

Upload HTTP PUT requests require a canonical nonnegative decimal
`upload-offset` header identifying the first byte of the submitted range.
The SQLite binding's `append(intentId, caller, bytes, expectedOffset)`
requires the same explicit offset. Matching retained ranges acknowledge
their end without appending; identical bytes at the next offset append
normally. Gaps, partial overlaps and changed retained bytes conflict.
`received_bytes` acknowledges this range's end; `complete` and `check`
describe the current validated transfer. An unchanged completed upload
can recover a lost reply. Finalized, rejected and expired intents never
reopen. The metadata-free `appendUploadContent` and `handleAppend` remain
legacy entry points without retry safety.

Finalization saves its publication reference/time before final bytes,
verifies exact bytes/count/digest and prior immutable metadata, then saves
the finalized intent before removing staging. SQLite commits the journey
mutation atomically. Separate FS bytes and persisted metadata can recover
interrupted serial publication; their ports require host serialization for
concurrent writers and do not imply multi-store or power-loss guarantees.
Retention cleans unpublished terminal bytes while published files keep
their own policy and immutable tombstones.

## Scripts

From the repository root, after `bun install --frozen-lockfile`:

```sh
bun run build --filter=@canlang/files
bun run --filter @canlang/files typecheck
bun run --filter @canlang/files test
```

The filtered root build schedules this package and its declared producer
dependencies. It emits only each owner’s outputs, cleaning them before execution
or cache restoration. Package `typecheck` and `test` use the same graph, then
run the owning TypeScript check or compiled `node:test` suite uncached.
Internal `build:emit`, `typecheck:check`, and `test:unit` tasks are execution
steps; use the public commands above to prepare dependencies.

## Source layout

```text
src/
  bridge.ts            # host bridge v1: intent auth, _meta ads, fallback
  catalog.ts           # additive versioned capability entries
  ports.ts             # port interfaces + TEST-ONLY doubles
  scenarios.ts         # scenario tables (none, pinned empty)
  finalize/index.ts    # finalize, ingest, attach, finalized reads
  provenance/index.ts  # request/event provenance binding
  retention/index.ts   # GC horizon, redaction, receipt projections
  upload/
    index.ts           # intent -> content -> complete state machine
    fs-blob-store.ts   # FS-backed BlobStorePort (journey impl)
test/
  bridge.test.ts contract-shapes.test.ts finalize.test.ts
  foreign.test.ts retention.test.ts scenarios.test.ts
  upload-journey.test.ts validation.test.ts helpers.ts
```

No `LICENSE` file exists in the repo, so no license pointer is given.
