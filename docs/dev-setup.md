# Developer setup (fresh machine)

The [architecture guide](ideal-filetree-plan.md) explains repository responsibilities and implementation direction.

Use the workspace commands below for local development. [Build scheduling](implementation/turbo-scheduling/README.md) explains producer dependencies and cache ownership.

## Prerequisites

- Bun 1.4.2 (`bun --version`) for installs and script runs, plus
  Node.js >= 22 (`node --version`) as the JS runtime: builds and tests
  still execute under Node, invoked through `bun run`. Node 24 is the verified runtime test profile. Turbo 2.11.7 installs from
  the frozen Bun lock. The task runner requires Node 22+ and keys caches by the
  executing host, Node and Bun versions; it does not enforce exact Bun/Turbo
  versions. The workerd binary downloads on first install; no Cloudflare account or
  credentials are needed for local build/test/dev.
- Rust 1.99 or newer for the `can` compiler (`compiler/Cargo.toml` declares
  this minimum). Native preparation separately selects 1.99.0 through its
  `rust-toolchain.toml`; install it with `rustup toolchain install 1.99.0`.
- Python 3.12+ for the language tools (`python3 --version`).
- Optional: `wrangler` for remote deploys (never needed for local work).

## Build, check, test

```sh
git clone --recurse-submodules https://github.com/veighnsche/canlang.git
cd canlang
bun install --frozen-lockfile
bun run build
```

For an existing checkout, initialize the draft submodule with
`git submodule update --init --recursive` before using draft examples.

Runtime fixtures need prerequisites beyond TypeScript package builds. From the
repository root, prepare the catalog, compiler profiles, packaged native
preparation binary and browser:

```sh
bun run catalog
bun run build:compiler
cargo build --locked --release --manifest-path compiler/Cargo.toml
node packages/cloudflare/scripts/build-preparation.mjs
bunx playwright install --with-deps chromium
```

Some existing fixtures explicitly select `compiler/target/release/can`; the
ordinary compiler build command uses the debug profile. Tests that invoke
`can dev` also need the [native development server](#native-development-server)
built before running. Then run the checks:

```sh
bun run typecheck
bun run check:boundaries
bun run check:unitban
bun run test
```

`bun run test` schedules producer builds, then runs the root Vitest suites,
including local workerd/D1 tests. `bun run test:all` also runs the owning
`test:integration` tasks (Interfaces, Services and Cloudflare) and emitted
Cloudflare runtime tests, with sequential suite scheduling. Typechecks and tests
always execute; producer `build` outputs are cacheable. Run one producer closure
with `bun run build --filter=@canlang/values`.

`bun run build:uncached` disables both cache reads and writes. Cached builds use
`.turbo/cache` locally; remote caching is disabled. Producers clean their owned
outputs and incremental state before a build or cache restoration. Current
commands and dependencies live in [package.json](../package.json) and
[turbo.json](../turbo.json); the former isolated cache-verification command is
no longer provided.

The [CI workflow](../.github/workflows/ci.yml) has three jobs:

- **Workspace and installed artifacts:** build packages, check boundaries and the
  unit-test bans, run selected native Work integration targets, typecheck the
  workspace, build native preparation/compiler prerequisites, generate the
  catalog, run `test:all`, and verify installed declarations/runtime on Node 24
  and the declared Node 22.0.0 minimum.
- **Compiler and editor:** format/lint the compiler, build real package/catalog
  prerequisites, run compiler tests with shell completion engines, then check
  editor grammar, compile its client and run LSP/client integrations.
- **Browser and security journeys:** build runtime/catalog/compiler prerequisites,
  typecheck the browser harness and run Playwright journeys.

CI currently installs the latest Bun and stable Rust, rather than enforcing the
local versions listed above. These are configured checks, not a statement that
all currently pass; the [remaining-task checklist](ideal-filetree-plan/tasks.md)
records known implementation and verification gaps.

The Python prototype has known drift: `python3 tools/can_parser.py draft examples` currently
exits 1; the draft corpus evolved past the Python prototype parser (owned
by the draft coordinator / lane-1 Rust track).

```sh
bun run build:compiler
bun run test:compiler
```

build and test the `can` compiler through uncached Cargo adapters. Existing
Cargo projects retain their native manifests. Values and work-kernel Wasm
generation remain explicit opt-in commands (`build:values-wasm` and
`build:work-wasm`); ordinary TypeScript builds stage the selected committed
bindings. The VS Code extension keeps its separate build outside this workspace.

## Native development server

Build the independent native development owner into the compatible compiler
target before using `can dev` from a checkout:

```sh
CARGO_TARGET_DIR="$PWD/compiler/target" CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_BUILD_JOBS=2 cargo build --locked --manifest-path dev-server/Cargo.toml
export CAN_DEV_BIN="$PWD/compiler/target/debug/can-dev"
compiler/target/debug/can dev ui --source App.can
```

Reuse a compatible owned target when one is already configured. The native owner
uses the built Cloudflare runtime bridge; ordinary source checks need no provider
credentials. Standalone archives bundle the matching native server and Node.

## Reviewing complexity

Follow [AGENTS.md](../AGENTS.md): keep responsibilities cohesive, reuse shared
mechanisms, preserve behavior and permissions, and use focused integration or
end-to-end checks. Simplify duplicated workflows rather than splitting functions
or files merely to reduce a metric.

Earlier versions of this guide described an advisory 11–20 source-AST
cyclomatic band and named commit `68c826de7c6e3fbd50fc7cfba9865ebea4213e13`
as the baseline for recorded scores above 20. This is historical guidance about
the former analyzer, with language-specific counting and excluded generated/test
code. That analyzer, its baseline/exception files and its CI gate are no longer
present; the old scores are not measurements of the current tree or current
acceptance thresholds. No rust-analyzer component is required for the checks
listed here.

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
and refuses conflicting captures; verification refuses duplicate recorded paths. It validates the package tree without packing or publishing.
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
to check existing outputs. A historical installed-type run recorded 150 typed
exports across 13 owners passing with 797 Miniflare 4.20260730.0 SDK declaration diagnostics visible. Those
counts describe that captured run, not current verification. The script checks
Can/consumer declarations and reports third-party diagnostics separately; its
success does not assert a clean whole-program library check.

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
use the [draft frontend validation runbook](draft-frontend-validation.md). It separates source checking, live browser smoke checks and still-open full-app acceptance.

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
Given contributions and frontend code. Generation requires native Codex login. Set `CAN_CODEX_BIN` to an absolute executable path when selecting a supported
installed client explicitly; doctor and execution use the same selection. There is no automatic model substitution. Ordinary compilation and the dev
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
without AI; `can validate` always checks saved output without generation. Both commands work from the repository root with the full source path, discover
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
- Fresh-clone `can dev` missing its entry: build the native server and set
  `CAN_DEV_BIN` as above. `can-platform` remains emitted JavaScript; its executable
  mode is restored by Cloudflare `build:emit` and Turbo restoration. Re-run the
  owning build after invoking `tsc` directly.
- For remote Wrangler deployment, configure authentication (such as
  `CLOUDFLARE_API_TOKEN`) and use the deploy command's explicit `--yes`
  confirmation.
