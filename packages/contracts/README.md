# @canlang/contracts

Type-only shared boundaries between CanLang producers. No execution engine,
no catalog, no runtime behavior lives here (CONTRACTS.md).

Ownership per `implementation/PLAN.md`: lane 07 assembles this manifest and
`src/index.ts`. Each `src/*.ts` boundary module is owned by its producer
lane; only `deployment.ts` and `examples.ts` exist until producers land
theirs. Consumers must not guess imports or duplicate these definitions.

Build: `npm run build -w @canlang/contracts` emits deterministic `dist/`
(JS + declarations + source maps) from `src/`.
