# D3b production qualification plan (scoping proposal, no code)

Base: main `46a5ece` (read-only; D P-commits untouched). Lane C scoping per
coordinator directive; implementation grants follow plan approval.

## Goal

Qualify the D3b selected-receipt read (`Receipt.read`) beyond narrow Node
acceptance: a supported packaged/bundled observer binding plus actual
target receipt-read evidence through the real deploy bundle.

## Current evidence (verified on main `46a5ece`)

FOUND (production path exists, observer leg missing):

- Deploy worker main: `packages/cloudflare/src/worker/main.ts` — the
  default-export fetch P-B bundles (`dist/worker/main.js`), with the
  sibling-join map (`./entry.js`, `./assembly.js`, `./artifact.js`,
  `./mcp-handler.js`, `../runtime/env-assembly.js`, …).
- Production transports route reads through the SAME `buildInvoker`
  bridge D3b tested: `packages/cloudflare/src/worker/assembly.ts:1195`
  (MCP) and `:1287` (HTTP) → `invokeReadCanonical` → D3b interception
  → `invokeSelectedReceiptRead` (`packages/cloudflare/src/runtime/invoke.ts`).
- P-B bundles the real MCP handler chain: `buildMcpBundle`
  (`packages/cloudflare/src/deploy/bundle.ts:600`).
- D3b serving + join accepted with Node-only evidence: 16 serving tests
  + 6 assembly tests (all `node --test` on dist / vitest).
- D live-serve addressing proofs 9/9 (convention B+E) + dispatch
  `unavailable` verdict 8/8 (`5edc3ba`; work suite 249/249).

ABSENT (the gaps this plan closes):

1. No packaged/bundled observer binding. `invokeSelectedReceiptRead`
   loads the observer via `loadProducerModule(
   "../../../state/dist/state/src/receipt/work-loader.js")`
   (`invoke.ts:2965,3325`), and `loadWorkReceiptFns`
   (`packages/state/src/receipt/work-loader.ts:77`) is explicitly
   TEST-ONLY: it dynamic-imports `../../../../../work/src/.../*.ts`
   through a computed file URL using Node type-stripping plus
   `node:url`/`node:path`. None of that resolves inside workerd, and
   the deploy bundler inlines nothing work-side today.
2. `packages/work` has no build script, no `main`/`exports`, and no
   `dist` (`packages/work/package.json`); it runs from TS source only.
   `packages/cloudflare/src/release/stamp.ts:12` documents work as
   pre-release for exactly this reason.
3. No workerd/production observer bindings anywhere: no wrangler
   config in repo; `runtime/env-assembly.ts` builds StoragePort +
   IdentityStore only (zero `observer`/`Receipt.read`/`invokeRead`
   mentions, verified by grep); `deploy/bundle.ts` and
   `dev/local-run.ts` likewise contain none.
4. No packaged receipt-read evidence: `Receipt.read` production code
   exists only in `runtime/invoke.ts`; no test exercises it through
   bundle/deploy/local-run paths.

## Approach

Keep the existing producer seam; replace the test-only loader leg with
a supported bundled leg. `invokeSelectedReceiptRead` already injects
the observer through the `loadWorkReceiptFns` producer looked up by
specifier — production-qual means giving that specifier a workerd-
resolvable target whose bytes P-B bundles, instead of the computed
`.ts` URL.

Rejected: static `@canlang/work` import from state/cloudflare source
(breaks the worker boundary and the T24a no-runtime-import precedent);
extending the test-only loader with fallback paths (fallback masks
bundler skew — the loader's own contract forbids it).

## Work units

### Q1 — Buildable `@canlang/work` observation dist (owner: D)

- Files: `packages/work/package.json` (add `build` + `exports`),
  `packages/work/tsconfig*.json` (new or existing), no source moves.
- Done when: `bun run --filter @canlang/work build` emits
  `packages/work/dist/.../observation.js` (+ `association.js`,
  `receipt/index.js`) with zero `node:`-only imports on the observer
  path; existing work suite still passes against source (no behavior
  change).
- Gate: package build exit 0 + `node --test` work suite green.

### Q2 — Production observer loader producer (owner: C, needs Q1)

- Files: new `packages/state/src/receipt/work-loader.production.ts`
  (name TBD with B; state-owned path, C-authored under grant) that
  exposes the same `loadWorkReceiptFns` shape but resolves the
  observer from a BUNDLED sibling specifier instead of the computed
  `.ts` URL; `packages/cloudflare/src/runtime/invoke.ts` gains a
  production specifier constant beside
  `STATE_RECEIPT_WORK_LOADER_SPECIFIER`, selected by the deploy join
  (Node keeps the test-only loader; workerd gets the bundled one).
- Done when: the loader imports nothing outside the bundle; a missing
  bundled observer fails loud (`deploy-join-missing` class), never
  silent.
- Gate: `tsc --noEmit` + existing D3b suites green (no behavior
  change on the Node leg).

### Q3 — P-B bundles the observer leg (owner: F, needs Q1+Q2)

- Files: `packages/cloudflare/src/deploy/bundle.ts` (new sibling
  entry, same `bun build` treatment as `buildMcpBundle`, same marker
  check), `packages/cloudflare/src/worker/main.ts` sibling-join map
  (+1 row), worker-boundary test allowlist if the new sibling needs
  one.
- Done when: a deploy bundle contains the observer bytes; the
  join-contract 500s (`deploy-join-missing`, wrong-export) cover the
  new sibling exactly like the existing ones.
- Gate: existing bundle/deploy suite green + new marker pin.

### Q4 — Actual target receipt-read evidence (owner: C, needs Q1–Q3)

- Files: new `packages/cloudflare/test/d3b-receipt-read-deploy.test.ts`
  (or `src/runtime/` equivalent) that boots the REAL P-B deploy
  bundle under miniflare/workerd with a D1-backed store, stages an
  app with a delivery field + association + receipt, and drives
  `Receipt.read` through `/mcp` `tools/call`: observed projection
  with numeric revisions, denied-identical-to-missing, stale-fence
  conflict, closed-input rejections. Precedent: the producer
  import-rewrite tests that already "boot the bundle with a DB".
- Done when: all four receipt-read behaviors pass against the bundled
  worker; the test fails if the observer sibling is dropped from the
  bundle (proves the evidence exercises the new leg).
- Gate: new test green under the granted TS slot; full vitest + node
  dist suites stay green.

## Validation plan

- Q1: `bun run --filter @canlang/work build` (exit 0) + work suite.
- Q2: package `tsc --noEmit` + D3b serving (16) + assembly (6) suites.
- Q3: bundle/deploy suites + new sibling marker pin.
- Q4: new deploy-bundle receipt-read test (4 behaviors) + bundle-drop
  negative + full gates. Highest-risk step: Q4's bundled-observer
  resolution under workerd (first execution of the new leg).

## What closes what

- The D3b DEPLOYMENT claim closes when Q1–Q4 are all green: supported
  packaged observer binding + bundled receipt-read evidence. That is
  the whole scope of this plan.
- T26 ("Implement associated observable progress", F06, depends T25)
  additionally requires progress-write/notification execution
  evidence (correlation, duplicates, cancellation, late usage,
  restart, terminal immutability, notification behavior per
  `docs/ideal-filetree-plan/finished-product/tasks.json`): owned by
  D (work-side progress) and B (state joins), NOT scoped here. This
  plan's Q4 is a prerequisite slice of T26, not T26 itself.

## Non-goals / risks

- Non-goals: T04b row-grant denied-as-data serving; durable
  notification joins; any B/state contract change beyond the
  production loader file; wrangler/publish automation.
- Risks: work sources may import `node:`-only modules on the observer
  path (Q1 discovers; fix is D-owned); sibling-specifier skew between
  Q2 and Q3 (mitigated by the marker check + loud 500s); miniflare
  D1 receipt-store fixture cost (mitigated by the existing
  boot-the-bundle-with-a-DB precedent).
- Open questions: none — all facts above were verified against main
  `46a5ece` by direct read/grep this run.
