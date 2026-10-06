# @canlang/cloudflare

Lane-07 Cloudflare delivery. Two sides with a hard boundary:

- **Node side** (`@canlang/cloudflare`): local dev runner, deploy-plan
  generation, compatibility checks, install/upgrade orchestration. May use
  Node APIs, Miniflare, and spawned `wrangler`.
- **Worker side** (`@canlang/cloudflare/worker`): Worker entry assembly.
  Must import no Node builtins or Node-only packages; enforced by
  `test/worker-boundary.test.ts`.

`src/build/` (artifact packaging) and `src/upgrade/` (activation/recovery)
land when compiler artifacts and producer inventory contracts exist; the
directories are created with their first real module, not before.

## Installed Worker bundling

Import `buildDeployBundle` from `@canlang/cloudflare/deploy/bundle` and pass
`{ verdict }`. Worker/MCP/HTTP entry files and producer module trees resolve
through installed package exports; a checkout root is unnecessary.

For explicit values WASM and browser assets:

```ts
import {
  buildDeployBundleWithAssets,
  writeDeployBundleWithAssets,
} from "@canlang/cloudflare/deploy/bundle";

const bundle = buildDeployBundleWithAssets(artifact, {
  verdict,
  assets: { valuesWasm: true, browser: true },
});
writeDeployBundleWithAssets(bundle, outputDirectory);
```

The bundler verifies producer manifests before staging bytes. Values bindings
and WASM belong to the Worker inventory; browser scripts/CSS are separate
`bundle.resources` entries for host asset serving. Selection does not initialize
or change the backend. The writer verifies both inventories before writing and
requires canonical output parents, rejecting existing symlinks. Browser routing
is still the serving host's responsibility. See the
[installed regression evidence](../../implementation/installed-worker-assets/README.md).

## `can-platform` CLI (L1 IR-03 delegation target)

Thin `can run|test|build|deploy` entries exec this binary, resolved from
`node_modules/.bin` after workspace install:

```
can-platform <run|test|build|deploy> --artifact <path> [--env <name>]
can-platform --help | -h | --version | -V
```

Exactly one JSON envelope on stdout on every path (`--help` included,
as `{ok:true,name,version,usage}`); human text on stderr only. `--help`
is honored in subcommand position too (`can-platform run --help`),
because L1 thin entries pass flags through verbatim. Exit 0
carries `{ok:true,...}`; exit 2 carries `{ok:false,command,code,detail}`
with `code` one of `usage`, `missing-artifact`, `missing-producer`
(names `producer` + `contract`), and exit 1 `internal`. Until L1 emission
and the L3 engine land, all four commands report `missing-producer`.
