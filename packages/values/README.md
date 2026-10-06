# @canlang/values

Exact values, schemas, wire codecs and pure standard builtins for CanLang.
Owner: lane 02. Internal package: the public facade is `@canlang/stdlib`
(lane 03), which re-exports the canonical names defined in `src/catalog.ts`.

## Commands

```sh
bun install --frozen-lockfile                # from the repo root (single workspace lock)
bun run --filter @canlang/values typecheck
bun run --filter @canlang/values test        # build + node:test over dist/test/
bun run --filter @canlang/values catalog     # build + emit versioned catalog JSON to dist/catalog.json
```

`node:test` is the package runner (the root vitest config explicitly leaves
producer runners to their owners; lane 03 also uses `node:test`).

## Constraints

- `src/` uses no `node:` imports: it must run on workerd as well as Node.
  Only `test/` and `scripts/` may use Node APIs.
- Exactness: integers, durations, money minors and versions are `bigint`;
  decimals are `Decimal` (`src/decimal.ts`); exact values are never routed
  through `Number` and never serialized with plain `JSON.stringify`.
- `src/` consumes the declared `@canlang/contracts/values` boundary.
  Named types remain erased; the contract version is a runtime export.
- JS export names equal Can builtin names verbatim (`add_days`, not
  `addDays`); operator lowering uses the DESIGN §13 helper names
  (`addMoney`, `equalValue`, ...). See `src/catalog.ts`.
- The catalog envelope implements the L1 IR-01 sketch
  (`catalog_version`/`language_version`/`entries`); L1 acknowledgment pending.
  Generated `dist/catalog.json` is a build artifact, not app config.
- Normative detail, representation decisions (R1-R5) and the JEV round live in
  `implementation/status/lane-02.md` and
  `implementation/evidence/jev/values-20261004/`.

Built JavaScript and declarations stay under this package: `dist/src/`,
`dist/test/`, and `dist/bindings/`. The normal build validates and stages
the committed opt-in WASM assets beside the binding hosts; rebuilding Rust
remains the separate root `bun run build:values-wasm` command. The `./distribution` export
locates the module and binding trees after installation. Opt-in hosts and
assets use the explicit `./bindings/*` exports listed in the manifest.
