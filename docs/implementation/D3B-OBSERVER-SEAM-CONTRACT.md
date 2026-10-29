# D3b Q2 observer seam contract (C-half deliverable)

Lane C Q2 C-half. The cloudflare serving path no longer hard-requires
the TEST-ONLY work-loader: `invokeSelectedReceiptRead` resolves its
selected-receipt observer in order — injected `opts.observer` > B's
worker-safe observer module > the work-loader leg (loud t16b at the
end, never a silent fallback). This document is the contract the
B-half module and F's Q3 rewrite entry must satisfy.

## Reconciliation (28 October 2026, B-half landing)

The shipped seam differs from the frozen Q2 text in three mechanical
respects, plus the taken B mechanism choice below; the shipped form
governs and the Q2 text further down is kept for history:

- **Specifier:** shipped `invoke.ts` resolves B through the package
  specifier `@canlang/state/receipt` (rewritten to
  `vendor/state/receipt/index.js`), whose re-exported
  `loadReceiptObserver` performs the relative `./observer.js` load —
  not through the frozen relative
  `../../../state/dist/state/src/receipt/observer.js` literal.
- **Dist path:** the state build emits
  `packages/state/dist/src/receipt/observer.js` (not
  `packages/state/dist/state/src/receipt/observer.js`); the vendor
  walk stages it as `vendor/state/receipt/observer.js` automatically.
- **F-half rewrite entry:** the literal relative-specifier entry is
  superseded — no `bundle.ts` entry is needed for the observer
  itself. The entry the B-half actually needed is the
  `@canlang/work/receipt` line in `mapVendorExtendedImport`, which
  rewrites the observer's dynamic leg to the staged
  `vendor/work/receipt/index.js` (mirroring the runtime map).
- **B mechanism (Q1 choice, taken):** the observer resolves the owning
  Work producer through a literal dynamic `import()` — no static
  `@canlang/work` edge (it would cycle), no file-URL loading. The
  package boundary guard carries a declared `contextualModuleLocators`
  exception for exactly this consumer + specifier.

## B-half: worker-safe observer module

- **File (B authors):** `packages/state/src/receipt/observer.ts`
- **Constraints:** zero node-only imports (`node:url`, `node:path`,
  `node:fs`, …); no dynamic file-URL loading; no `@canlang/work`
  static runtime import (Q1's worker-safe observer source decides the
  mechanism — B owns that choice).
- **Dist path (frozen by the seam):**
  `packages/state/dist/state/src/receipt/observer.js`
- **Specifier (frozen by the seam, `invoke.ts`
  `STATE_RECEIPT_OBSERVER_SPECIFIER`):**
  `../../../state/dist/state/src/receipt/observer.js`
- **Export (frozen by the seam, `StateReceiptObserverProducer`):**
  ```ts
  loadSelectedReceiptObserver(): Promise<{
    readonly observeSelectedReceipt: (input: unknown) => unknown;
  }>
  ```
- **Semantics:** `observeSelectedReceipt` MUST be observationally
  interchangeable with the work-loader's `observeSelectedReceipt`
  for every input the join (`observeSelectedReceiptJoin`) passes:
  same outcomes, same errors, same evaluation order. The serving
  path hands it straight to the join — no adaptation, no wrapping.
- **Acceptance:** the Q2 seam tests drive the production leg through
  injection today; once B lands, a B-owned test MUST drive
  `invokeSelectedReceiptRead` with NO injection against B's module
  AND prove the call went through B's module positively — e.g. B's
  observer records its invocations, or returns a marker the test
  asserts. Identical-output-to-the-injected-run alone does NOT
  prove bypass (post-D1 the output could still come from the
  work-loader leg). Plus a worker import smoke (module resolves
  from the vendor map after F's rewrite).

## F-half (Q3): rewrite entry

Add to the `rewriteRuntimeImports` literal map in
`packages/cloudflare/src/deploy/bundle.ts` (F owns that file — C
does NOT edit it):

- source: `../../../state/dist/state/src/receipt/observer.js`
- vendor key: `vendor/state/receipt/observer.js`
- vendor entry const (F names it, mirroring
  `STATE_D1_VENDOR_ENTRY`): `vendor/state/receipt/observer.js`

The vendor walk picks the module up automatically once it exists in
state dist (it is NOT in `TEST_ONLY_VENDOR_KEYS`). F's link check
must prove the staged bundle resolves the observer specifier from
the vendor map. The sibling `receipt/join.js` specifier needs its
P-B rewrite in the same pass (F's Q3 scope, not this contract).

## Resolution order (shipped in `invoke.ts`)

1. `opts.observer` (per-call injection; assembly/production binding)
2. observer module via `STATE_RECEIPT_OBSERVER_SPECIFIER` (absent
   until B lands)
3. work-loader leg via `STATE_RECEIPT_WORK_LOADER_SPECIFIER`
   (checkout/dev; in the worker its vendor key is pinned out, so
   it misses too and the existing loud t16b refuses)

Neither-module-resolves refuses loud down every branch — the
disjunction the Q4 probe pins empirically
("workerd's real observer miss
shape refuses loud down every branch"): EITHER the observer
miss reads loud under `isObserverModuleAbsent` (direct
refusal) OR it reads absent and the work-loader fallback leg
misses too (loud t16b). No silent fallback was added.

## Repair notes (A-review D1/D2, fix-forward on the pick)

- D1: the fallback is absent-module ONLY
  (`isObserverModuleAbsent`: `ERR_MODULE_NOT_FOUND` naming
  `receipt/observer.js` as the MISSING module). A present-but-broken
  observer — eval throw, missing export, loader/shape failure,
  nested missing dep, unknown workerd miss shape — is loud and
  never masked by the fallback. B-half implication: once your
  module exists, every defect in it surfaces loudly; there is no
  quiet revert to the work-loader leg.
- D2: the injection leg is reachable from production reads, not
  future — `CanonicalReadOpts.observer?` spreads through
  `invokeReadCanonical` into `invokeSelectedReceiptRead`, so the
  assembly can bind the production observer per call today.

## Ownership

- C: seam + resolution + injection + this contract (this half).
- B: `observer.ts` module + B-owned no-injection test + worker
  import smoke (B-half follows on this contract).
- F: Q3 rewrite entries (observer + sibling join) + link-check
  proof + vendor-map ownership.
- D: Q1 worker-safe observer source (already the critical path).
