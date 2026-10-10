# @canlang/state (internal)

The one authoritative commit engine for CanLang (lane 03). It implements canonical
operation admission, authorized record queries, CRUD/invariants/locks/hooks, D1
revision-fenced and Durable Object local transactions, receipts/history/outbox/
schedule atomicity, and owner-local migration execution.

Generated programs import the thin `@canlang/stdlib` facade (lane 03 assembly),
which re-exports producer surfaces. This package never imports that facade back.

## Layout

- `src/catalog.ts` — versioned machine-readable entry manifest.
- `src/errors.ts` — safe business rejections (`StateError`, stable codes).
- `src/invocation/`, `src/query/`, `src/policy/`, `src/mutation/`, `src/storage/`,
  `src/migration/` — engine modules (land slice by slice; see
  `implementation/status/lane-03.md`).
- `src/ports.ts` — constrained transaction/read/system-command ports for lanes 4/6/7.
- `test/` — `node:test` suites; storage suites run against real miniflare D1/DO APIs.

## Contracts

Shared boundary types live in `packages/contracts/src/state.ts` (lane 03 owned) and
are imported here by relative source path until lane 07 assembles the workspace and
`contracts` index. Engine-local descriptor/codec shims needed before lanes 01/02 land
are marked interim and replaced at those joins — never a second catalog.

`createFileReferenceConsumer` is the owning current File read and retention-fact
consumer. Bind it to the trusted app/team/owner store, the same loaded canonical
and artifact models, loaded `valueTypes` when present, current operation registry,
policies and Identity reader, with finite `maxRows` and `maxReferences` bounds.
`observeReferences(ref)` enumerates all committed direct and embedded File slots,
including archived retained rows and duplicate nested array positions. Each fact
retains its owning model, row/version, top field and relative wire `path`; the
legacy `index` is the top array position. Malformed wires, incomplete declarations,
overflow or a changed State revision refuse completeness. The observation and its
`revalidate()` grant no read permission and provide no cross-store deletion lock.

`read({model, recordId, field, ref}, authenticatedCaller, consume)` requires the
exact current whole-field grant (including its row predicate), owning model and
parent reads, current row lifetime, complete wire and coherent Identity facts.
It checks those same bindings and the original State revision before and after
one physical byte callback, then returns detached bytes or null. The host closes
`consume` over Files' genuine current policy/lifetime/digest-verified reader and
original physical receiver; the current authorized reader is a separate identity.
Host credential provenance, native download wiring and serialization through
retention deletion remain owning host/Files integration requirements.

## Build and test

```sh
bun install --frozen-lockfile   # from the repo root
bun run --filter @canlang/state typecheck
bun run --filter @canlang/state test
```

Dependencies are exact-pinned; the single root `bun.lock` is lane 07 owned.

`build:emit` also bundles the original `test/storage/do-test-worker.js` with
the actual emitted DO adapter and its declared dependency closure into
`dist/test/storage/do-test-worker.js`. Internal loaders and the public
`@canlang/state/testing/storage/do-test-worker` export use this built asset.
The worker protocol and real Miniflare SQLite/transaction assertions stay
unchanged. Missing or browser-incompatible dependencies fail the build; the
bundler removes its old asset before attempting to rebuild it. The test worker
is not a production deployment or a substitute for owning adapter qualification.
