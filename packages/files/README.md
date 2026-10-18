# @canlang/files

File upload intake, finalization, provenance, retention, and host bridge
for CanLang. Request/event provenance is bound at finalization and frozen
afterwards; every byte and metadata read re-verifies the caller against
the bound owner and fails closed. Internal package; the public surface
assembles in `@canlang/stdlib`.

The package has a root entry and explicit exported subpaths; import the
capability you need.

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
- `src/retention/index.ts`: `runRetention`, `runRetentionBatch`, `describeForReceipt`
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
- `src/scenarios.ts`: `FILES_SCENARIO_TABLES` (empty)
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

The SQLite store now retains a stable `fileStoreId`. Trusted deployment
composition can bind its original `FileReferenceStoragePort` through
`createSqliteFileBindings`'s `fileRetirement: { storage, retention }` option.
The first exact State/store/receiver assignment persists permanently; reopen
must use the same assignment. `deleteRetiredFile(ref)` reads the original
permanent State decision through the captured lookup, then checks the physical
metadata, bytes, current policy/clock and original policy/disposition. One real
SQLite transaction saves that whole decision and matching terminal tombstone
with byte deletion. Missing bytes succeed only with the same original journal
and terminal metadata. Changed facts, missing issuance or repinning refuse.

Once assigned, finalized byte deletion/overwrite/append and terminal or
attachment-time regressions through the public ports refuse; public transactions
grant no cleanup permission. Legacy full/batch retention also refuses on that
profile, including after reopen without issuer configuration. Staging and
unpublished final-byte cleanup retain their separate existing semantics.
Controlled lookup tests qualify these Files mechanics only. The genuine
persisted D1 State issuer and separate Files SQLite consumer are also qualified
in Work's existing retirement integration test: permanent original issuance,
physical rollback, both-store reopen, exact journal retry and legacy refusal.
The reviewed State implementation supplies complete framework/declaration and
commit/publication/activation guards. Dev's complete all-writer/owner binding and
native lifecycle/reopen qualification remain prerequisites for a supported host.
No DTO, callback, live observation or structural port cast establishes issuance.
Retention cleans unpublished terminal bytes while published files keep
their own policy and immutable tombstones.

The SQLite binding exposes `runRetentionBatch(config, {limit, cursor})`.
The explicit limit is an integer from 1 through 1000 shared by intent and
file traversal. `processed` counts every visited row, including ineligible
and terminal records. Storage uses ordered keysets and SQL limits; it never
loads a full collection or an extra lookahead row. Pending-intent cleanup
may need one file lookup to protect published bytes. `metadataReads` counts
traversed rows plus these point lookups, including absent results, and is
bounded by twice the limit. Byte-size checks and idempotent deletion
operations are separately bounded per visited row.

Save `next` only after a successful call. The SQLite binding commits
metadata and bytes together; retry an interrupted call with its prior
cursor. A full page can require a final empty probe. When `next` is null,
that sweep is complete; start a later sweep with a null/omitted cursor to
revisit newly due rows and insertions before the previous cursor. The clock
is fresh per batch. This is a traversal position rather than a frozen
snapshot, authority or disposal deadline. `runRetention` retains its
legacy unbounded full-list behavior. Shared attachment lifetime, download
authority and provider/native qualification remain separate.

## Retained finalized-file observations

`observeFinalizedFile` reads actual metadata and bytes under an explicit
receiving File policy and retention policy. It verifies the current receiver,
live lifecycle, native finalization time, full provenance, detected type,
size and digest. `readFinalizedFileObservation` authenticates only its original
opaque handle through private object identity. Copies, serialized data and
matching shapes supply no live observation. The extracted facts are detached,
frozen and JSON-safe.

`revalidateRetainedFinalizedFile` compares saved facts with the current physical
file and current policy. Both captured and current retention horizons apply,
anchored to the original finalization time; a longer current policy cannot
renew the captured lifetime. These are captured observation policy facts,
not evidence of a policy persisted at finalization. Logical expiry applies
before a sweep, missing or changed bytes refuse, and terminal files stay closed.

An attached marker alone cannot bypass the unattached deadline. The owning
clock records the first `attachedAtMs` through `recordAttachment`; the observer
requires it to precede each applicable unattached deadline. Late or unproven
legacy marks cannot revive expired availability, and retries preserve that
first time. Clockless legacy marker calls retain their existing behavior.

The SQLite binding consumes these producers as `observeFile(ref, caller,
retention)` and `revalidateFile(saved, caller, retention)` in its shared
metadata/byte transaction. Other hosts must supply consistent serialized
reads. Neither a handle nor saved facts grant row, attachment or disclosure
authority. State must bind a genuine live observation to its actual checked
final field/write and receipt; recovery must recheck current row authority.
Dev and Compiler own the actual typed-file source/replay consumers. Shared
reference lifetime and authenticated provider ingress remain separate.

`readCurrentFinalizedBytes` returns the exact physical byte snapshot checked
by that same validator under explicit current File and retention policies.
The SQLite binding exposes it as `readCurrentBytes(ref, physicalReceiver,
retention)` inside its metadata/byte transaction. It refuses missing,
corrupt, terminal, foreign or logically expired files before a retention
sweep, and performs no second byte read or metadata write. Legacy
`readFinalizedBytes`/`readBytes` retain their physical receiver checks.

`readCurrentFinalizedSnapshot` returns frozen `{facts, bytes}` from that same
single validation. Its immutable `RetainedFinalizedFile` facts describe the
exact detached bytes returned, including content type, size and digest. The
SQLite binding exposes `readCurrentSnapshot(ref, physicalReceiver, retention)`
in the same transaction. Response consumers use these facts with these bytes;
a separate provenance read can become stale across an awaited binding. Bytes
remain mutable and detached; this snapshot is neither an observation handle
nor a State disclosure grant.

The protected read consumer must obtain State's current whole-field grant
and exact File occurrence, then recheck State and Identity after asynchronous
physical reads before disclosing bytes. Dev supplies the actual compiled
locator and current caller/physical receiver correspondence. Shared reference
retention additionally needs complete committed slots and a host fence through
byte deletion; the single attachment marker cannot establish that contract.

The complete D1 State plus separate `files.sqlite` deployment profile remains
unqualified for shared-reference physical deletion. The implemented direction is
permanent durable retirement in the authoritative State owner: the complete
census, its original revision and installed declaration correspondence must
admit retirement under one State fence. Every subsequent live-reference writer,
migration publication and schema activation must honor that admission barrier.
Packages consumes the exact persisted issuer and immutable physical File
identity before terminal metadata and byte deletion in the Files transaction;
Dev supplies complete owner/store routing and interruption/reopen recovery.
The State issuer and Files consumer now exist; the actual host binding and
complete native workflow remain owning prerequisites. An awaited census,
revision revalidation, ordinary decision DTO or process-local mutex cannot
substitute for them. Existing low-level sweeps retain their Files-local scope;
the decision does not activate a cross-store cleanup path or change retention
policy, engines, native preparation or publication holds.

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
  scenarios.ts         # scenario tables (none)
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
