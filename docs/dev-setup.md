# Developer setup (fresh machine)

Repository organization is tracked in the [living ideal file-tree plan](ideal-filetree-plan.md). After every merge, its handler reconciles changes since the checkpoint and updates the plan; its proposals remain deferred until separately authorized.

Verified verbatim on macOS on 2026-10-04 from a clean clone (commit
`173e4b6`, lane-07 status holds the evidence log; bun-workspace commands
re-verified locally the same day during the npm-to-bun migration). Linux
CI runs the same commands via `.github/workflows/integration.yml`.

## Prerequisites

- Bun >= 1.4 (`bun --version`) for installs and script runs, plus
  Node.js >= 22 (`node --version`) as the JS runtime: builds and tests
  still execute under Node, invoked through `bun run`.
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
bun run test
```

`bun run test` builds first, then runs every lane-07 suite including real
local-workerd tests (HTTP + D1, no network). Expect all suites green.

```sh
python3 -m unittest discover -s tools -p "test_jev.py"
```

plus the parser boundary suite (see the `tools` job in
`.github/workflows/integration.yml` for the exact filter). These run the
mocked tools tests. `python3 tools/can_parser.py draft examples` currently
exits 1: the draft corpus evolved past the Python prototype parser (known
drift, owned by the draft coordinator / lane-1 Rust track).

```sh
cd compiler && cargo build --locked
```

builds the `can` compiler binary.

## Run one example app locally

No compiled-app serving yet: the B1 join (`tests/integration/b1-team-tasks.md`)
is blocked on lane-1 emission. Until then, the closest local proof is the
testkit isolation test, which serves a fixture Worker with per-row D1:

```sh
bunx vitest run packages/testkit/test/isolation.test.ts
```

## Troubleshooting

- A native/bundled dependency (workerd/esbuild) misbehaving after
  install: wipe and reinstall from the lock
  (`rm -rf node_modules && bun install --frozen-lockfile`); the default
  install already works here.
- Stale `dist/` after switching branches: `rm -rf packages/*/dist` and
  rebuild (`tsc -b` incremental state can wedge across rebases).
- `wrangler` remote commands need `CLOUDFLARE_API_TOKEN`; nothing in this
  repo runs them without asking.
