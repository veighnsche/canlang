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

## `can-platform` CLI (L1 IR-03 delegation target)

Thin `can run|test|build|deploy` entries exec this binary, resolved from
`node_modules/.bin` after workspace install:

```
can-platform <run|test|build|deploy> --artifact <path> [--env <name>]
can-platform --help | -h | --version | -V
```

Exactly one JSON envelope on stdout on every path (`--help` included,
as `{ok:true,name,version,usage}`); human text on stderr only. Exit 0
carries `{ok:true,...}`; exit 2 carries `{ok:false,command,code,detail}`
with `code` one of `usage`, `missing-artifact`, `missing-producer`
(names `producer` + `contract`), and exit 1 `internal`. Until L1 emission
and the L3 engine land, all four commands report `missing-producer`.
