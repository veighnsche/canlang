# @canlang/files

File upload intake, finalization, provenance, retention, and host bridge
for CanLang. Request/event provenance is bound at finalization and frozen
afterwards; every byte and metadata read re-verifies the caller against
the bound owner and fails closed. Internal package; the public surface
assembles in `@canlang/stdlib`.

Ownership per `implementation/PLAN.md`: lane 04
(`prompts/04-work-services-files.md`) owns the file lifecycle. There is
no barrel `src/index.ts`; import the module you need directly.

## Install

Private bun workspace member. From the repo root:

```sh
bun install
```

## Usage

Host routing with the bridge (dependency-light example):

```ts
import { createBridgeOrigin, routeHost } from './src/bridge.ts';

const origin = createBridgeOrigin('https://app.example');
if (origin === null) throw new Error('bad origin');
const route = routeHost(origin, { name: 'host', fileTransferVersions: [1] });
// { action: 'bridge-v1',
//   meta: { version: 1, intents: 'https://app.example/files/intents' } }
```

Key exports by module:

- `src/upload/index.ts`: `createUploadIntent`, `appendUploadContent`,
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
  `handleAppend`, `handleComplete`, `handleFinalize`,
  `FILE_TRANSFER_META_KEY`
- `src/ports.ts`: `assertSafeBlobKey` plus the `TestOnly*` doubles
  (`TestOnlyManualClock`, `TestOnlyMemoryBlobStore`,
  `TestOnlyMemoryIntentStore`, `TestOnlyMemoryFinalizedStore`,
  `TestOnlyCounterIntentIds`, `TestOnlyCounterFileIds`,
  `TestOnlyFixedPrincipal`)
- `src/catalog.ts`: `filesCatalog`, `FILES_CATALOG_VERSION`
- `src/scenarios.ts`: `FILES_SCENARIO_TABLES` (pinned empty, by design)

## Scripts

Only the scripts in `package.json`:

| Script      | Command                          |
| ----------- | -------------------------------- |
| `typecheck` | `tsc --noEmit`                   |
| `test`      | `node --test 'test/**/*.test.ts'` |

Run from the repo root:

```sh
bun run --filter @canlang/files typecheck
bun run --filter @canlang/files test
```

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
