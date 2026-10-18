# @canlang/values

Exact values, schemas, wire codecs and pure standard builtins for CanLang.
Internal package: the public facade is `@canlang/stdlib`, which re-exports
the canonical names defined in `src/catalog.ts`.

## Commands

```sh
bun install --frozen-lockfile                # from the repo root (single workspace lock)
bun run --filter @canlang/values typecheck
bun run --filter @canlang/values test        # build + node:test over dist/test/
bun run --filter @canlang/values catalog     # build + emit versioned catalog JSON to dist/catalog.json
```

`node:test` runs the package tests.

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
- The catalog envelope contains `catalog_version`, `language_version` and
  `entries`. Generated `dist/catalog.json` is a build artifact, not app config.

Built JavaScript and declarations stay under this package: `dist/src/`,
`dist/test/`, and `dist/bindings/`. The normal build validates and stages
the committed opt-in WASM assets beside the binding hosts; rebuilding Rust
remains the separate root `bun run build:values-wasm` command. The `./distribution` export
locates the module and binding trees after installation. Opt-in hosts and
assets use the explicit `./bindings/*` exports listed in the manifest.

Timezone calculation keeps the original host-accepted zone string. Its two
private formatter caches each retain at most 64 entries, with least-recently-used
eviction. Rebuilding an evicted entry uses the same original string and formatter
options; the limit changes retention, never zone admission or returned values.
It bounds 128 retained calculation formatters, not total ICU memory or construction
work. Validation still uses the current host on every call.

The language/runtime release must pin the actual Intl host build and its loaded
ICU, timezone and CLDR data for calendar, zone and localized output correspondence
under [DESIGN's calendar, localization and language-version rules](../../docs/specification/DESIGN.md).
Runtime engine compatibility alone does not establish
those data identities; alias names reported by Node and Bun need not match.
When data versions are not exposed, the release owner must identify them through
the pinned runtime artifact rather than borrow another host's versions. The
independent currency scale table remains the checked-in SIX publication dated
2026-09-17 in `src/currency-data.ts`. No cache policy changes that table or the
release's existing semantic corpus requirement.
