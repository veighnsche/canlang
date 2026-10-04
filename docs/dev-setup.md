# Developer setup (fresh machine)

Verified verbatim on macOS on 2026-10-04 from a clean clone (commit
`173e4b6`, lane-07 status holds the evidence log). Linux CI runs the same
commands via `.github/workflows/integration.yml`.

## Prerequisites

- Node.js >= 22 with npm 11 (`node --version`, `npm --version`).
  The workerd binary downloads on first install; no Cloudflare account or
  credentials are needed for local build/test/dev.
- Rust toolchain 1.99.0 for the `can` compiler (`rustup toolchain install 1.99.0`).
- Python 3.12+ for the language tools (`python3 --version`).
- Optional: `wrangler` for remote deploys (never needed for local work).

## Build, check, test

```sh
git clone https://github.com/veighnsche/canlang.git
cd canlang
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm test
```

`npm test` builds first, then runs every lane-07 suite including real
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
npx vitest run packages/testkit/test/isolation.test.ts
```

## Troubleshooting

- `npm warn install-scripts ... workerd/esbuild`: npm 11 gates postinstall
  scripts. If a package misbehaves, run `npm install-scripts approve
  <pkg>` and reinstall; the default install already works here.
- Stale `dist/` after switching branches: `rm -rf packages/*/dist` and
  rebuild (`tsc -b` incremental state can wedge across rebases).
- `wrangler` remote commands need `CLOUDFLARE_API_TOKEN`; nothing in this
  repo runs them without asking.
