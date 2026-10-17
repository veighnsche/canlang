# Developer setup (fresh machine)

Repository organization is tracked in the [living ideal file-tree plan](ideal-filetree-plan.md). After every merge, its handler reconciles changes since the checkpoint and updates the plan; its proposals remain deferred until separately authorized.

Verified verbatim on macOS on 2026-10-04 from a clean clone (commit
`173e4b6`, lane-07 status holds the evidence log; bun-workspace commands
re-verified locally the same day during the npm-to-bun migration). Linux
CI runs the same commands via `.github/workflows/integration.yml`.

The 2026-10-06 [Turbo scheduling round](implementation/turbo-scheduling/README.md)
updates the workspace commands below. Its cache proof and runtime results have
their own source/tool pins; the original fresh-clone qualification above remains
historical evidence.

## Prerequisites

- Bun 1.4.2 (`bun --version`) for installs and script runs, plus
  Node.js >= 22 (`node --version`) as the JS runtime: builds and tests
  still execute under Node, invoked through `bun run`.
  Node 24 is the verified runtime test profile. Turbo 2.11.7 installs from
  the frozen Bun lock; public tasks verify the Bun and Turbo pins.
  The workerd binary downloads on first install; no Cloudflare account or
  credentials are needed for local build/test/dev.
- Rust toolchain 1.99.0 for the `can` compiler (`rustup toolchain install 1.99.0`).
- Python 3.12+ for the language tools (`python3 --version`).
- Optional: `wrangler` for remote deploys (never needed for local work).

## Build, check, test

```sh
git clone https://github.com/veighnsche/canlang.git
cd canlang
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run check:boundaries
bun run test
```

`bun run test` schedules producer builds, then runs the root Vitest suites,
including local workerd/D1 tests. `bun run test:all` adds the ten owning
Node test commands and emitted Cloudflare runtime tests, with sequential suite
scheduling. Typechecks and tests always execute; only TypeScript producer builds
are cacheable. Run one producer closure with
`bun run build --filter=@canlang/values`.

`bun run verify:turbo-cache` creates an isolated snapshot and frozen install,
then verifies the actual graph, restoration of every output byte and file mode,
upstream invalidation, source rollback/deletion and failed-producer blocking.
It preserves its raw evidence in the temporary directory printed on completion.
`bun run build:uncached` disables both cache reads and writes for reproducibility
checks. Cached builds use `.turbo/cache` locally; remote caching is disabled.

```sh
bun run test:tools
```

plus the parser boundary suite (see the `tools` job in
`.github/workflows/integration.yml` for the exact filter). These run the
mocked tools tests. `python3 tools/can_parser.py draft examples` currently
exits 1: the draft corpus evolved past the Python prototype parser (known
drift, owned by the draft coordinator / lane-1 Rust track).

```sh
bun run build:compiler
bun run test:compiler
```

build and test the `can` compiler through uncached Cargo adapters. Existing
Cargo projects retain their native manifests. Values and work-kernel Wasm
generation remain explicit opt-in commands (`build:values-wasm` and
`build:work-wasm`); ordinary TypeScript builds stage the selected committed
bindings. The VS Code extension keeps its separate build outside this workspace.

## Catalog and release checks

```sh
bun run catalog
bun run release
bun run release:pack
bun run verify:installed-types
```

`catalog` builds the values dependency closure, then emits
`packages/values/dist/catalog.json` uncached. `release` schedules the producer
builds, then checks version lockstep, writes the release manifest, and verifies
both the recorded digest and byte count for each file uncached. The manifest
builder records each path once across repeated or overlapping selected roots
and refuses conflicting captures; verification refuses duplicate recorded paths.
It validates the package tree without packing or publishing.
`release:stamp`, `release:manifest`, and `release:verify` are direct
checks of an already built tree; use `release` to prepare it.

`release:pack` prepares all owners and runs the same uncached release validation,
then packs all 13 workspaces into `output/release-artifacts/`. Its `manifest.json`
records tarball hashes, versions and internal runtime dependency closure. Private
dependencies are included with their private flags preserved. The command makes
artifacts only; it does not publish packages, build native releases or qualify
native preparation hosts. The
[release workflow](../.github/workflows/release.yml) assembles downloadable
compiler, package and editor artifacts.

`verify:installed-types` prepares package outputs, packs and installs all owners
in an outside-checkout consumer with Bun’s isolated linker, then uses TypeScript
5.9.3 for strict NodeNext checking with `skipLibCheck: false`. Every declared type
export must resolve inside that consumer, expose symbols and use declared owned
dependencies. Can declarations and the consumer fixture must have no diagnostics;
missing/corrupt declaration controls must fail the same gate. Add `--skip-build`
to check existing outputs. The [installed type evidence](implementation/turbo-scheduling/evidence/final-acceptance/types/README.md)
records the scope: 150 typed exports across 13 owners pass, while all 797
Miniflare 4.20260730.0 SDK declaration diagnostics remain visible. This is a
scoped Can/consumer result; whole-program strict library checking does not pass.

The installed declaration and Worker/runtime consumers also accept
`--minimum-node22` when invoked with exactly Node22.0.0, the declared minimum
engine. Use that executable to run both existing scripts with `--skip-build`
and `--minimum-node22` against matching built outputs. This mode retains actual
checkout-read denial using Node22's `--experimental-permission`, including the
nested installed Work serving control. Default invocations retain the separate
Node24 permission profile. CI runs both profiles; minimum-engine qualification
does not establish other hosts or original native application acceptance.

## Run one example app locally

For current protected dev-preview screenshots and the complete draft inventory,
use the [draft frontend validation runbook](draft-frontend-validation.md).
It separates source checking, live browser smoke checks and still-open full-app acceptance.

The [prompt pipeline fixture](../tests/fixtures/prompt-pipeline/README.md)
uses the native `can` CLI for generation and full app validation:

```sh
bun run catalog
bun run build:compiler
export PATH="$PWD/compiler/target/debug:$PATH"
cd tests/fixtures/prompt-pipeline
can gen PromptStudio.can --dry-run
can gen PromptStudio.can
can validate PromptStudio.can
```

Its committed recipes request Codex `gpt-6.1-sol` with medium reasoning for
Given contributions and frontend code. Generation requires native Codex login.
Set `CAN_CODEX_BIN` to an absolute executable path when selecting a supported
installed client explicitly; doctor and execution use the same selection.
There is no automatic model substitution. Ordinary compilation and the dev
server consume saved outputs without invoking a coding agent.

The generator receives an immutable source snapshot and submits logical outputs
through the private generation MCP server. Before promotion the host compiles
the frozen candidate, runs `can build` and all compiled Can example rows, then
runs the app's own `playwright.config.ts` (or JS equivalent) against the candidate
through the real dev server. Missing examples/config/browser dependencies,
skipped browser tests, failed checks or changed candidate inputs block
acceptance. Current saved files remain active. Reports and candidate screenshots
are retained under the app's `.can/gen/checks/` directory. Submissions alone never
overwrite working code.
`can gen PromptStudio.can --retry` deliberately regenerates all prompts in this
app. Default generation reuses fresh saved units and validates the whole app
without AI; `can validate` always checks saved output without generation.
Both commands work from the repository root with the full source path, discover
the built platform automatically, and accept `--format=json`. The platform's
JavaScript runtime remains an internal dependency; users do not invoke it or a
fixture wrapper. Acceptance screenshots remain with their `.can/gen/checks/`
report; standalone browser runs save the fixture's `playwright/screenshots/`.

## Troubleshooting

- A native/bundled dependency (workerd/esbuild) misbehaving after
  install: wipe and reinstall from the lock
  (`rm -rf node_modules && bun install --frozen-lockfile`); the default
  install already works here.
- Stale `dist/` after switching branches: run `bun run build`. Every scheduled
  producer cleans its owned outputs and incremental state before building or
  restoring a cache entry, so removed source files leave no stale emissions.
- Fresh-clone `can docs` or `can dev` failing with `E7004`/`Permission denied`
  on `can-platform` or `can-dev`: `tsc` emits the CLI files without `+x`. Both
  modes are repaired by Cloudflare `build:emit`, and Turbo restoration preserves
  them, so either documented build
  leaves an executable bin. If you invoked `tsc -b`/`tsc -p` directly,
  bypassing both scripts, re-run one of the documented builds instead
  of hand-chmodding the output.
- `wrangler` remote commands need `CLOUDFLARE_API_TOKEN`; nothing in this
  repo runs them without asking.
