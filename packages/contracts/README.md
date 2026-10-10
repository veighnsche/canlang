# @canlang/contracts

Type-only shared boundaries between CanLang producers. No execution engine,
no catalog, no runtime behavior lives here (CONTRACTS.md).

Ownership per `implementation/PLAN.md`: lane 07 assembles this manifest and
`src/index.ts`. Each `src/*.ts` boundary module is owned by its producer
lane; only `deployment.ts` and `examples.ts` exist until producers land
theirs. Consumers must not guess imports or duplicate these definitions.

Build: `bun run build --filter=@canlang/contracts` emits deterministic `dist/`
(JS + declarations + source maps) from `src/`.

The `./distribution` export locates the built module tree after installation.
The `./values` export preserves the exact value-contract module surface.

The root also exports the defining File retirement types from `state.ts` and
`files.ts`. `FileReferenceStoragePort` requires one permanent store authority,
complete persisted declarations, retirement/readback and checked migration
publication/activation. Generic `StoragePort` has no such capability. State must
implement the atomic guards even through legacy calls; Files and Dev must consume
the genuine persisted issuer and physical pins. These declarations implement no
storage or deletion and do not qualify the current cross-store profile.
