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

## Build and test (standalone until the L7 workspace adopts this manifest)

```sh
cd packages/state
npm install
npm run typecheck
npm test
```

Dependencies are exact-pinned (no lockfile; the root workspace lock is lane 07 owned).
