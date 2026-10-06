# CanLang end-to-end harness (e2e track)

Browser end-to-end suites for compiled Can apps. The harness serves a real
workerd instance with real D1 behind a localhost HTTP bridge and drives it
with Playwright. See also L7's `docs/dev-setup.md` (runner setup) and
`tests/integration/README.md` (join contribution contract, which e2e follows:
owned surfaces only, `local` evidence labels, loud `unsupported` rows, cleanup).

## Layout

```text
playwright.config.ts        # lane-07-owned config; chromium-only
tests/e2e/
  tsconfig.json             # scaffold check (NOT in root check or vitest)
  bridges/http-bridge.ts    # localhost TCP -> LocalDev.dispatch forwarder
  fixtures/artifact-loader.ts  # CompileArtifact v1 -> startLocalDev modules
  fixtures/e2e-test.ts      # worker fixtures: workerd + bridge + D1 schema
  fixtures/seed.ts          # D1 + identity seeding over real backends
  fixtures/handbuilt/       # fixture workers (until L1 PR6 emission)
  apps/scaffold.spec.ts     # harness smoke (label-asserted, always runs)
  apps/teamtasks.spec.ts    # TeamTasks journeys: login, CSRF, authz, D1 state
  apps/*.spec.ts            # follow-on per-app suites (same fixtures)
docs/e2e.md                 # this file
```

## Running

Use the tool pins in [developer setup](dev-setup.md). From the repository root:

```sh
bun install --frozen-lockfile
bun run build:compiler
bunx playwright install --with-deps chromium
bun run typecheck:e2e
bun run test:e2e
```

The public e2e typecheck and test commands schedule the declared TypeScript
producer graph automatically, including UI and identity. Compiled fixtures
also require `compiler/target/debug/can`; `build:compiler` explicitly builds
that native prerequisite through the uncached Cargo adapter. Browser installation
and compiler compilation are separate from the cached TypeScript producers.
The loader bundles real producer outputs and fails when an output or compiler
is missing. A passing fixture or compiled suite proves only its asserted
journeys; it does not qualify all applications or native preparation hosts.

## Honesty rules (binding)

1. The bridge owns no business logic; 502 marks bridge failure, never app state.
2. Until L1 PR6 emission, every run is labeled `fixture/handbuilt/<app>`
   (asserted by specs). A fixture run can never masquerade as compiled.
3. What is real pre-PR6: workerd, D1, L6 auth/session logic, ui rendering,
   PBKDF2 login, HMAC CSRF. What is hand-built: route wiring, page
   descriptor, D1 schema, the `/__e2e/seed` endpoint. In-render row reads
   throw loud until the PR6 dispatcher exists.
4. Identity rows live in a real L6 memory store; the fenced-D1 store (join J2)
   is NOT proven by e2e and must not be claimed from it.
5. No identity semantics are invented in `tests/e2e`: only existing L6
   exports are called. A journey needing a NEW L6 API is a gap for L6.
6. `can-platform run|test` gate `missing-producer` until L1 emission; e2e
   drives `startLocalDev` directly and adopts the CLI only at B1 binding.

## Ownership

- Lane 07 owns the whole e2e track: `tests/e2e/**`, root
  `playwright.config.ts`, this doc (scaffold adopted from L5 PR #97; the
  prior L5 authoring grant is revoked), plus the runner (`startLocalDev`,
  `LocalDev.dispatch` stability), root `package.json`/lock,
  `.github/workflows/*`, `tests/integration/*`, `docs/dev-setup.md`, and
  the lane-07-owned packages (`packages/cloudflare`, `packages/testkit`,
  contracts manifest/export assembly + `deployment.ts`/`examples.ts` —
  other producers own their own packages).
