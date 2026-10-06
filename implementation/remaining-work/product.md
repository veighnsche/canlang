# Finished-product joins and remaining documentation

Reconciled against main `7fd8c6b` on 2026-10-06. [Index](../REMAINING-WORK.md) · [Exact ledger](tasks.json).

Only unresolved tasks are listed below. Completed narrow tasks are retained in the exact ledger and are not assigned again. All workers remain stopped; D’s port remains human-held. Conditional/deferred rows are separate from selected required work.

## finished-product

## Required remaining — finished-product

### FP.IDENTITY-CONTRACT — Release typed identity conditional outcome/context/fence contract

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.IDENTITY-CONTRACT` · REQUIRED
- Resolve the proposed shared-fence J2 design with the state/identity owner, answering the four recorded questions; retain triple JEV results as advice, then release a typed conditional/context/fence contract.
- Declared dependencies: `challenge:T04`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Exact table/owner transaction participants, verified anonymous/session/grant context, one-use winner, last-owner/role/recovery atomicity, replay/rollback and origin binding. System registration alone insufficient. Consult triple JEV for consequential unsettled mechanism with verified full context before selection.
- Defining-owner paths from the old plan: `packages/contracts/src/identity.ts`, `packages/identity/src/ports.ts`, `packages/state/src/ports/identity.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: FP.IDENTITY-CONTRACT.contract.md is explicitly PROPOSED; final owner selection and the actual batch boundary are unresolved.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/ideal-filetree-plan/finished-product/FP.IDENTITY-CONTRACT.contract.md](../../docs/ideal-filetree-plan/finished-product/FP.IDENTITY-CONTRACT.contract.md), [docs/ideal-filetree-plan/integration-20261006-identd.json](../../docs/ideal-filetree-plan/integration-20261006-identd.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.IDENTITY — Join identity lifecycle to real authoritative storage

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.IDENTITY` · REQUIRED
- Implement/qualify each token-consumption, last-owner, role, recovery and membership feature through the released typed conditional participant; prove one winner and atomic rollback on actual durable storage.
- Declared dependencies: `finished-product:FP.IDENTITY-CONTRACT`, `challenge:T16`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Typed conditional winner and constrained batch, no raw SQL feature bypass; source-present APIs revalidated under actual D1/DO/revocation/retry proof.
- Defining-owner paths from the old plan: `packages/identity/src/storage/commands.ts`, `packages/identity/src/storage/d1.ts`, `packages/state/src/storage/d1.ts`, `packages/cloudflare/src/runtime/env-assembly.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Source APIs exist; the proposed contract records unfenced check-then-act/feature cascades and no production concurrency proof.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/ideal-filetree-plan/finished-product/FP.IDENTITY-CONTRACT.contract.md](../../docs/ideal-filetree-plan/finished-product/FP.IDENTITY-CONTRACT.contract.md), [packages/identity/src/storage/d1.ts](../../packages/identity/src/storage/d1.ts). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.BROWSER — Ship and qualify browser/assets and polling lifecycle

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.BROWSER` · REQUIRED
- Mount retained asset/bootstrap/CSS/polling source in the real installed page/auth/action path; qualify all 68 catalog bindings and live DOM, keyboard/focus/forms/navigation and termination/obsolete-response behavior.
- Declared dependencies: `challenge:T15`, `challenge:T19`, `challenge:T20`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All 68 catalog bindings, real installed CSS/HTMX/client/static path, focus/keyboard/unsaved forms and URL/history; authorized one-inflight poll, visibility/context/logout termination and obsolete responses/actions.
- Defining-owner paths from the old plan: `packages/ui/src/browser/bootstrap.ts`, `packages/ui/src/browser/polling.ts`, `packages/ui/scripts/build-browser.mjs`, `packages/ui/src/browser/style.css`, `packages/interfaces/src/http/assets.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: E asset handler and F browser/bootstrap/polling source were retained; consolidation explicitly leaves route, binder/DOM, current-authority and installed joins open.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [packages/ui/src/browser/bootstrap.ts](../../packages/ui/src/browser/bootstrap.ts), [packages/ui/src/browser/polling.ts](../../packages/ui/src/browser/polling.ts), [packages/cloudflare/src/worker/assembly.ts](../../packages/cloudflare/src/worker/assembly.ts). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.PREFERENCES — Join checked preference metadata/current storage/consumer

- [ ] **Acceptance evidence missing** · `finished-product:FP.PREFERENCES` · REQUIRED
- Trace checked source preference metadata into current self/owner/app/team storage and real consumer; qualify reference fallback/default/reset/conflict/cancel/bound-tab save independently of business authority.
- Declared dependencies: `challenge:T15`, `challenge:T20`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Self/owner/app/team key, current reference fallback/default/reset/conflict/cancel and bound-tab save; base shared account settings separate; never changes business authority.
- Defining-owner paths from the old plan: `packages/state/src/preferences/schema.ts`, `packages/state/src/preferences/commands.ts`, `packages/state/src/preferences/reads.ts`, `packages/interfaces/src/http/preferences.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Source context and UI paths exist, but no recorded complete preference storage/consumer acceptance covers this requirement.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.CSV — Close source-derived CSV intake server review and per-row commit

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.CSV` · REQUIRED
- Qualify the existing parse/preview/confirm, review/commit and route joins against source-derived original app operations with current reference/file authority, per-row replay and partial/unknown results; retain invalid/excluded rows and renewed consent.
- Declared dependencies: `challenge:T19`, `challenge:T20`, `challenge:T32`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Preserve invalid/duplicate rows, renewed consent on changed candidates, authorized pure review before each frozen-identity confirmation, canonical independent replay-safe outcomes/partial failure.
- Defining-owner paths from the old plan: `packages/interfaces/src/http/csv.ts`, `packages/ui/src/csv/parse.ts`, `packages/ui/src/csv/preview.ts`, `packages/ui/src/csv/confirm.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Six FP.CSV integration records prove scoped source and unit/seam witnesses; actual original compiled/storage/browser acceptance is not recorded.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [packages/interfaces/src/http/csv.ts](../../packages/interfaces/src/http/csv.ts), [packages/ui/src/csv/parse.ts](../../packages/ui/src/csv/parse.ts), [packages/ui/src/csv/preview.ts](../../packages/ui/src/csv/preview.ts), [packages/ui/src/csv/confirm.ts](../../packages/ui/src/csv/confirm.ts), [docs/ideal-filetree-plan/integration-20261006-fpcsvjoin.json](../../docs/ideal-filetree-plan/integration-20261006-fpcsvjoin.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.EXPORT — Close authorized bounded CSV export/Print and large-output lifecycle

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.EXPORT` · REQUIRED
- Supply the durable large-output status/expiry backend behind the existing descriptor URLs; qualify guarded download/restart/replay/current row/field/file authority and source-declared Print through actual installed consumers.
- Declared dependencies: `challenge:T20`, `challenge:T24`, `challenge:T32`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Current row/field/file grants, explicit completeness/limits/currency/ID/version columns/formula handling; durable status/expiry guarded downloads for large exports; Print declared authorized view.
- Defining-owner paths from the old plan: `packages/interfaces/src/http/export.ts`, `packages/interfaces/src/http/print.ts`, `packages/ui/src/browser/export.ts`, `packages/ui/src/browser/print.ts`, `packages/work/src/exports/jobs.ts`, `packages/work/src/exports/download.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: export.ts explicitly identifies the large-output descriptor as contract only and D-owned backend follow-up; server/browser/dispatch/join slices are narrower witnesses.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [packages/interfaces/src/http/export.ts](../../packages/interfaces/src/http/export.ts), [packages/interfaces/src/http/print.ts](../../packages/interfaces/src/http/print.ts), [packages/ui/src/browser/export.ts](../../packages/ui/src/browser/export.ts), [packages/ui/src/browser/print.ts](../../packages/ui/src/browser/print.ts), [docs/ideal-filetree-plan/integration-20261006-fpexpjoin.json](../../docs/ideal-filetree-plan/integration-20261006-fpexpjoin.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.POLICY-REVIEW — Connect staff business review to checked owner facts

- [ ] **Acceptance evidence missing** · `finished-product:FP.POLICY-REVIEW` · REQUIRED
- Derive and qualify staff-facing business review directly from checked permissions/actions/exceptions/defaults/assumptions/examples; display unresolved intent and truthful approval/provider availability.
- Declared dependencies: `challenge:T04`, `challenge:T15`, `challenge:T20`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Same-source permissions/actions/exceptions/defaults/assumptions/examples, unresolved intent and truthful approval/availability. No copied prose policy.
- Defining-owner paths from the old plan: `compiler/src/review.rs`, `packages/contracts/src/review.ts`, `packages/interfaces/src/projection/review.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: The accepted duty is recorded; reviewed files and presentation helpers do not establish a complete checked business-review consumer.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.LIFETIME — Implement owner expiry and sensitive-copy disposal

- [ ] **Not implemented / no execution evidence** · `finished-product:FP.LIFETIME` · REQUIRED
- Release the owning contract/mechanism and implement the missing required join under separately authorized scope.
- Archived/locked records, child/reference lifetime, safe replay identity, sensitive history/receipt/outbox disposal and physical erasure delay/restart; file GC alone insufficient.
- Declared dependencies: `challenge:T15`, `challenge:T17`, `challenge:T25`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Archived/locked records, child/reference lifetime, safe replay identity, sensitive history/receipt/outbox disposal and physical erasure delay/restart; file GC alone insufficient.
- Defining-owner paths from the old plan: `packages/state/src/retention/expiry.ts`, `packages/state/src/retention/disposal.ts`, `packages/state/src/retention/recovery.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: The finished-product list records this required join as a new proposed packet; the current scoped consolidation provides no implementation or end-to-end acceptance for it.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.FILES-DURABLE — Join file metadata/blob durable lifecycle

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.FILES-DURABLE` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- Real receiving-app bytes/digest/provenance/finalization/attachment/read, upload/principal limits, restart/duplicate/conflicting-output proof; async interface release, no R2+state atomicity promise.
- Declared dependencies: `challenge:T04`, `challenge:T16`, `challenge:T24`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Real receiving-app bytes/digest/provenance/finalization/attachment/read, upload/principal limits, restart/duplicate/conflicting-output proof; async interface release, no R2+state atomicity promise.
- Defining-owner paths from the old plan: `packages/files/src/storage/metadata.ts`, `packages/files/src/storage/blob.ts`, `packages/files/src/storage/recovery.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.CORPUS — Connect accepted model-bound corpus and opaque grounding

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.CORPUS` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- Accepted grammar preserved. Real origin/principal/scope and all actually used immutable context verified at retrieval and every disclosure; opaque nonconstructible Answer, truthful coverage/as-of, current revocation/withdrawal, index repair and genuine fixtures. T12 B8 exclusion is availability, not deferral.
- Declared dependencies: `challenge:T13`, `challenge:T14`, `challenge:T15`, `challenge:T24`, `challenge:T25`, `challenge:T26`, `challenge:T32`, `finished-product:FP.FILES-DURABLE`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Accepted grammar preserved. Real origin/principal/scope and all actually used immutable context verified at retrieval and every disclosure; opaque nonconstructible Answer, truthful coverage/as-of, current revocation/withdrawal, index repair and genuine fixtures. T12 B8 exclusion is availability, not deferral.
- Defining-owner paths from the old plan: `packages/contracts/src/corpus.ts`, `packages/state/src/corpus/sources.ts`, `packages/state/src/corpus/grounded.ts`, `packages/state/src/corpus/available.ts`, `packages/state/src/corpus/status.ts`, `packages/services/src/corpus/index.ts`, `packages/services/src/corpus/controller.ts`, `packages/services/src/corpus/extract.ts`, `packages/services/src/corpus/normalize.ts`, `packages/cloudflare/src/runtime/work/corpus.ts`, `packages/testkit/src/fixtures/corpus.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.INSTALLED-RELEASE — Close outside-checkout release facts/producer closure

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.INSTALLED-RELEASE` · REQUIRED
- Complete outside-checkout producer/dependency/docs/browser/vendor/actual values-work binary/native inventory and prove cold/full CLI/Worker on every explicitly claimed host; resolve native release dependency only after its human HOLD.
- Declared dependencies: `ports:C04.graph`, `ports:C04.values-assets`, `ports:C04.work-assets`, `ports:C04.native-release`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Install complete actual runtime/docs/browser producer closure and assets without workspace siblings/compiler Cargo.toml; cold/full installed CLI and Worker proofs on every claimed host; actual numeric/work binaries not smoke.
- Defining-owner paths from the old plan: `packages/cloudflare/src/release/inputs.ts`, `packages/cloudflare/src/deploy/producer-inventory.ts`, `.github/workflows/release.yml`, `docs/install.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Combined build and local suites passed at fdb059c; consolidation limits them to their command scope and excludes outside-checkout, remote, human-HOLD and full app acceptance.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.UPGRADE-JOIN — Connect source-derived staged upgrade and recovery

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.UPGRADE-JOIN` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- Exact installed predecessor/desired schema, bounded complete-state/work inventory, staged validation, fenced activation/recovery, negative unknown/unsupported transitions; retain truthful online limitations.
- Declared dependencies: `challenge:T15`, `challenge:T17`, `challenge:T24`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Exact installed predecessor/desired schema, bounded complete-state/work inventory, staged validation, fenced activation/recovery, negative unknown/unsupported transitions; retain truthful online limitations.
- Defining-owner paths from the old plan: `packages/cloudflare/src/upgrade/host.ts`, `packages/cloudflare/test/upgrade-installed.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.DOC-REQUIREDNESS — Reconcile reference stored-array creation facts

- [ ] **Acceptance evidence missing** · `finished-product:FP.DOC-REQUIREDNESS` · REQUIRED
- Compare current reference, form/MCP/state creation facts for ordinary omitted arrays versus required arrays; repair only proven disagreement, preserving distinct signature-parameter requiredness.
- Declared dependencies: `challenge:T09`, `description:D04`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Ordinary arrays omit to empty; required arrays differ; reference/form/MCP/state agree. Signature params remain distinct; no blanket count updates.
- Defining-owner paths from the old plan: `compiler/src/docs.rs`, `compiler/tests/docs.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: BOUND-DOC-ARRAY records a source correspondence defect; D-series support does not certify the cross-consumer ordinary-array behavior.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.COMPILED-DECIMAL — Close exact decimal expression lowering

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.COMPILED-DECIMAL` · REQUIRED
- Release owner-derived exact constructor and implement expression lowering; qualify preserved authored magnitude/scale and invalid/ambiguous/range controls in genuinely compiled output.
- Declared dependencies: `challenge:T11`, `challenge:T13`, `challenge:T15`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Real owner-derived exact constructor/lowering preserving authored integral magnitude/scale, constraints and no Number/i64 intermediary; meaningful invalid/ambiguous/range controls; package-only port unchanged.
- Defining-owner paths from the old plan: `compiler/src/codegen/js.rs`, `compiler/src/codegen/ir.rs`, `packages/values/src/catalog.ts`, `packages/stdlib/src/index.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: compiler/src/codegen/js.rs:1530 still refuses IrExpr::Decimal with E6008; metadata/default spelling support is a distinct existing path.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [compiler/src/codegen/js.rs:1530](../../compiler/src/codegen/js.rs). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.QUALIFY — Qualify all accepted original workflow families

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.QUALIFY` · REQUIRED
- Run per-app full required behavior and negative gates for all 49 original app/companion intent ledgers and shared declarations using canonical compiled examples and meaningful actor/browser/MCP/durable/provider journeys; dependencies gate only matching apps.
- Declared dependencies: `challenge:T37`, `challenge:T38`, `challenge:T39`, `challenge:T40`, `finished-product:FP.IDENTITY`, `finished-product:FP.BROWSER`, `finished-product:FP.PREFERENCES`, `finished-product:FP.CSV`, `finished-product:FP.EXPORT`, `finished-product:FP.POLICY-REVIEW`, `finished-product:FP.LIFETIME`, `finished-product:FP.CORPUS`, `finished-product:FP.UPGRADE-JOIN`, `finished-product:FP.COMPILED-DECIMAL`, `finished-product:FP.CONTEXT`, `finished-product:FP.DISPATCH-AVAILABILITY`, `finished-product:FP.MAINTENANCE`, `finished-product:FP.PING`, `finished-product:FP.INSTRUMENTATION`, `finished-product:FP.ALERTS`, `finished-product:FP.SOURCE-MAPPINGS`, `finished-product:FP.SERVICE-CATALOG`, `finished-product:FP.MAILBOX`, `finished-product:FP.REPORTS`, `finished-product:FP.TRACKER`, `finished-product:FP.INVOCATION`, `finished-product:FP.APP-ADJUDICATION`, `finished-product:FP.AW-MAILBOX`, `finished-product:FP.AW-PAYMENTS`, `finished-product:FP.AW-DOCUMENTS`, `finished-product:FP.AW-SOURCE-CONNECTOR`, `finished-product:FP.AW-ONBOARD-HANDOFF`, `finished-product:FP.AW-JUDGMENT`, `finished-product:FP.AW-REPLAY-IMPORT`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All 49 app intent dispositions with full declared required workflows/negatives, real canonical compiled examples, meaningful multi-actor/browser/MCP/persistence/retry/recovery; per-app gates and honest provider/storage evidence.
- Defining-owner paths from the old plan: `tests/e2e/journeys/original-corpus.spec.ts`, `tests/e2e/journeys/apps-delivery-installed.spec.ts`, `tests/e2e/journeys/apps-analytics-installed.spec.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: 49 intent records and scoped tests exist; no all-required-app installed qualification is certified by the structural/app review.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.FULL — Review full intended-product supported release

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.FULL` · REQUIRED
- Review all required, conditional, deferred and declined outcomes plus installed/runtime/example/economic/recovery proofs; close independently challenged duty review and reconcile every merge delta before supported-release/checkpoint claim.
- Declared dependencies: `challenge:T41`, `description:D08`, `ports:A11`, `ports:V12`, `ports:W08`, `ports:P11`, `ports:C04.complete`, `ports:C05.complete`, `finished-product:FP.QUALIFY`, `finished-product:FP.INSTALLED-RELEASE`, `finished-product:FP.DOC-REQUIREDNESS`, `finished-product:FP.SOURCE-CLOSURE`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Complete source/duty review, independently challenged owners, actual source/artifact/runtime/examples/installed workflow proofs, package/current/prepared/Rust economics, precise required/conditional/deferred/declined ledger and upgrade/rollback. Optional W09 stays outside. Reconcile every accumulated merge delta before checkpoint advance.
- Defining-owner paths from the old plan: `docs/ideal-filetree-plan.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Publication and local passing suites retain all programme gates; optional W09 remains excluded and no full supported release was accepted.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.CONTEXT — Close verified source context and allowed-hook carriers

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.CONTEXT` · REQUIRED
- Release per-scope verified actor/team/now/operation context, lower and carry actual readonly id/source values through generated nonhook and allowed-hook execution; qualify actor-null/current-scope/rejected-use controls.
- Declared dependencies: `challenge:T04`, `challenge:T15`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Lower actor/team/now/operation from the same verified current invocation, without ambient free variables. Preserve operation readonly id/source and all accepted per-scope bounds; hook context must be released by its owner, not inferred from nonhook c. Required sites compile and execute with meaningful actor-null/current-scope negatives. B4 report is proposal/source evidence.
- Defining-owner paths from the old plan: `compiler/src/codegen/ir.rs`, `compiler/src/codegen/js.rs`, `packages/cloudflare/src/runtime/context.ts`, `packages/cloudflare/src/runtime/invoke.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: HandlerContext has caller/clock/canonical scope but no actor/now/team/operation properties; B4 report and late challenge retain carrier/lowering gaps.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [packages/cloudflare/src/runtime/context.ts:90](../../packages/cloudflare/src/runtime/context.ts), [compiler/B4-G-NONHOOK-CONTEXT-BINDINGS.md](../../compiler/B4-G-NONHOOK-CONTEXT-BINDINGS.md), [docs/ideal-filetree-plan/finished-product/reviews/late-challenge-language.json](../../docs/ideal-filetree-plan/finished-product/reviews/late-challenge-language.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.DISPATCH-AVAILABILITY — Join deployment availability to durable send outcome

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.DISPATCH-AVAILABILITY` · REQUIRED
- Release and wire actual target/capability/resource availability into physical dispatch with ordered authority/claim behavior; persist terminal transport/receipt outcomes and recovery without redrive; refresh W01/W04/W06/W07 profiles.
- Declared dependencies: `challenge:T12`, `challenge:T24`, `finished-product:FP.SOURCE-MAPPINGS`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Use current owning source/actual target binding and optional host availability contract; preserve lifecycle -> availability -> guard -> revalidation -> claim trace where injected. Current Cloudflare mirror omits availability and rejects unavailable; physical drive mints/persists held claim and awaits snapshot/authority before replaying kernel callbacks. Release the actual producer/mirror/order and durable terminal transport/receipt/persist/recovery mapping explicitly; an unavailable kernel return alone neither persists terminal state nor qualifies runtime. Prove missing versus broken/temporarily unavailable deployment policy, withheld guard/revalidation/claim, actual compiled sends and source namespace. Original required corpus/provider outcomes remain required, not declined. Refresh W01/W04/W06/W07 callback/outcome/ABI profiles; retain unknown broad JS on TS.
- Defining-owner paths from the old plan: `packages/cloudflare/src/runtime/work/providers.ts`, `packages/cloudflare/src/runtime/invoke.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Pure work kernel availability callback exists; late independent dispatch review found mirror omission/unavailable rejection and earlier physical held-claim ordering.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [packages/work/src/dispatch/index.ts:197](../../packages/work/src/dispatch/index.ts), [docs/ideal-filetree-plan/finished-product/reviews/late-dispatch.json](../../docs/ideal-filetree-plan/finished-product/reviews/late-dispatch.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.MAINTENANCE — Join configured trusted maintenance to owner admission

- [ ] **Not implemented / no execution evidence** · `finished-product:FP.MAINTENANCE` · REQUIRED
- Release the owning contract/mechanism and implement the missing required join under separately authorized scope.
- Cloudflare transport resolves configured request; state owns constrained canonical maintenance admission. Configured source/team/version and canonical constraints, candidate hooks, owner fence/history/replay/outbox; Check and Catch maintenance require same commit authority. No product configuration tools or direct SQL bypass.
- Declared dependencies: `challenge:T16`, `challenge:T17`, `challenge:T28`, `challenge:T29`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Cloudflare transport resolves configured request; state owns constrained canonical maintenance admission. Configured source/team/version and canonical constraints, candidate hooks, owner fence/history/replay/outbox; Check and Catch maintenance require same commit authority. No product configuration tools or direct SQL bypass.
- Defining-owner paths from the old plan: `packages/cloudflare/src/maintenance/records.ts`, `packages/state/src/maintenance/admission.ts`, `packages/contracts/src/state.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: The finished-product list records this required join as a new proposed packet; the current scoped consolidation provides no implementation or end-to-end acceptance for it.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.PING — Join provisioned heartbeat ingress

- [ ] **Not implemented / no execution evidence** · `finished-product:FP.PING` · REQUIRED
- Release the owning contract/mechanism and implement the missing required join under separately authorized scope.
- Configured namespace+secret GET/POST, noncached bounded responses and durable canonical ping before ACK; current token/revision, unknown/revoked key negatives and restart/due/pause/recovery races; notice acceptance does not reset health.
- Declared dependencies: `finished-product:FP.MAINTENANCE`, `challenge:T24`, `challenge:T32`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Configured namespace+secret GET/POST, noncached bounded responses and durable canonical ping before ACK; current token/revision, unknown/revoked key negatives and restart/due/pause/recovery races; notice acceptance does not reset health.
- Defining-owner paths from the old plan: `packages/interfaces/src/health/ping.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: The finished-product list records this required join as a new proposed packet; the current scoped consolidation provides no implementation or end-to-end acceptance for it.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.INSTRUMENTATION — Close minimized versioned error capture and intake

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.INSTRUMENTATION` · REQUIRED
- Connect retained minimized browser capture to authenticated configured ErrorsV1 source/project intake, quota/replay/work fence, deleted-project suppression and independent raw/diagnostic retention; prove installed retry/health behavior.
- Declared dependencies: `finished-product:FP.MAINTENANCE`, `challenge:T24`, `finished-product:FP.LIFETIME`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Explicit ErrorsV1 source/project binding, bounded UTF-8 before parse, pinned redaction before queue/group/files, nonblocking nonrecursive SDK, quota/replay/work single fence and retry-horizon safe tombstones. Deleted project suppression, sourced fresh/stale/unavailable intake health and independent raw/diagnostic lifetime.
- Defining-owner paths from the old plan: `packages/services/src/instrumentation/reports.ts`, `packages/services/src/instrumentation/redaction.ts`, `packages/services/src/instrumentation/grouping.ts`, `packages/interfaces/src/instrumentation/intake.ts`, `packages/ui/src/browser/instrumentation.ts`, `packages/cloudflare/src/runtime/instrumentation.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: integration-20261006-fcapture records browser capture source and 2-file scoped qualification; complete intake/retention/consumer journey remains required.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [packages/ui/src/browser/instrumentation.ts](../../packages/ui/src/browser/instrumentation.ts), [docs/ideal-filetree-plan/integration-20261006-fcapture.json](../../docs/ideal-filetree-plan/integration-20261006-fcapture.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.ALERTS — Qualify safe installed heartbeat alert adapter

- [ ] **Not implemented / no execution evidence** · `finished-product:FP.ALERTS` · REQUIRED
- Release the owning contract/mechanism and implement the missing required join under separately authorized scope.
- Owning AlertsV1 acceptance/source/destination/message schema and explicit provider mapping; bounded public HTTPS egress, redirect/current destination/credential restrictions, safe diagnostic and current dispatch guard. Durable Notice association/acceptance stays distinct from heartbeat health or external job success.
- Declared dependencies: `finished-product:FP.SOURCE-MAPPINGS`, `challenge:T24`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Owning AlertsV1 acceptance/source/destination/message schema and explicit provider mapping; bounded public HTTPS egress, redirect/current destination/credential restrictions, safe diagnostic and current dispatch guard. Durable Notice association/acceptance stays distinct from heartbeat health or external job success.
- Defining-owner paths from the old plan: `packages/services/src/alerts/adapter.ts`, `packages/services/src/alerts/egress.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: The finished-product list records this required join as a new proposed packet; the current scoped consolidation provides no implementation or end-to-end acceptance for it.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.SOURCE-MAPPINGS — Release configured provider namespaces and causation

- [ ] **Not implemented / no execution evidence** · `finished-product:FP.SOURCE-MAPPINGS` · REQUIRED
- Release the owning contract/mechanism and implement the missing required join under separately authorized scope.
- Owning versioned declarations/capability schemas and explicit provisioned namespaces; source request digest/committed cause/action/delivery/domain revision. Commission allocation versus bank outcome, contradictions/reversals and source qualifications stay distinct; no guessed name routing or cross-owner provider transaction.
- Declared dependencies: `challenge:T12`, `challenge:T14`, `challenge:T24`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Owning versioned declarations/capability schemas and explicit provisioned namespaces; source request digest/committed cause/action/delivery/domain revision. Commission allocation versus bank outcome, contradictions/reversals and source qualifications stay distinct; no guessed name routing or cross-owner provider transaction.
- Defining-owner paths from the old plan: `packages/services/src/source-mappings.ts`, `packages/services/src/adapters/commission.ts`, `packages/services/src/adapters/discovery.ts`, `packages/services/src/adapters/registry.ts`, `packages/cloudflare/src/runtime/work/providers.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: The finished-product list records this required join as a new proposed packet; the current scoped consolidation provides no implementation or end-to-end acceptance for it.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.SERVICE-CATALOG — Complete required standard provider consumers

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.SERVICE-CATALOG` · REQUIRED
- Complete owner-generated selected provider signatures and real installed consumers/configuration; qualify required text/media/file/progress/reconcile and unavailable/cancel/unknown journeys independently.
- Declared dependencies: `challenge:T12`, `challenge:T14`, `challenge:T24`, `finished-product:FP.FILES-DURABLE`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Owner-generated signatures, exact selected provider adapters and current approved hosted configuration; real text/media/file output/progress/reconcile and meaningful unavailable/cancel/unknown cases. Existing harness or adapter export cannot certify declared Chat/Creative journeys.
- Defining-owner paths from the old plan: `packages/services/src/standard/text-generation.ts`, `packages/services/src/standard/images.ts`, `packages/services/src/catalog.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Current catalog exports four adapters; adapter presence and harness tests do not qualify all original required provider journeys.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [packages/services/src/catalog.ts:24](../../packages/services/src/catalog.ts). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.MAILBOX — Release MailboxV1 catalog and receiving-file consumer contract

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.MAILBOX` · REQUIRED
- Release owner-derived MailboxV1 receiving-file catalog/coordinator and join the private actual producer; qualify authenticated source/MIME/file completeness/receipt/reply/reconcile/retry and terminal not_sent cases.
- Declared dependencies: `finished-product:FP.SOURCE-MAPPINGS`, `finished-product:FP.FILES-DURABLE`, `challenge:T24`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Release the owning MailboxV1 catalog/receiving-file contract and thin standard coordinator; FP.AW-MAILBOX supplies the private actual producer and conformance. Authenticated installed mailbox source; normalized MIME and receiving-app immutable files finalized before inbox commit; content-bound source identity, conflicting redelivery refusal, completeness, reply and reconcile separate from Email.send. Preserve bounded attempts and exhausted unknown evidence.
- Defining-owner paths from the old plan: `packages/services/src/standard/mailbox.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: services/src/catalog.ts exposes Email send, Chat, SystemOne evaluation and Images submit; it does not expose Mailbox receiving/reply/reconcile.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [packages/services/src/catalog.ts:24](../../packages/services/src/catalog.ts), [packages/contracts/src/services.ts:933](../../packages/contracts/src/services.ts). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.REPORTS — Join finite source-derived reporting and historical coverage

- [ ] **Not implemented / no execution evidence** · `finished-product:FP.REPORTS` · REQUIRED
- Release the owning contract/mechanism and implement the missing required join under separately authorized scope.
- Finite typed dimensions/weighted intervals and current delegated read audience; complete checkpoint/range/site/reversal coverage, immutable financial producer/digest, exact currency/unit separation and N/A/unavailable. Historical day/calendar/price evidence requires owning source verdict; no invented backfill or arbitrary SQL.
- Declared dependencies: `finished-product:FP.SOURCE-MAPPINGS`, `challenge:T17`, `challenge:T15`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Finite typed dimensions/weighted intervals and current delegated read audience; complete checkpoint/range/site/reversal coverage, immutable financial producer/digest, exact currency/unit separation and N/A/unavailable. Historical day/calendar/price evidence requires owning source verdict; no invented backfill or arbitrary SQL.
- Defining-owner paths from the old plan: `packages/services/src/reports/sources.ts`, `packages/services/src/reports/checkpoints.ts`, `packages/services/src/analytics/dimensions.ts`, `packages/services/src/analytics/mapping.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: The finished-product list records this required join as a new proposed packet; the current scoped consolidation provides no implementation or end-to-end acceptance for it.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.TRACKER — Close consent/session tracker and intake

- [ ] **Not implemented / no execution evidence** · `finished-product:FP.TRACKER` · REQUIRED
- Release the owning contract/mechanism and implement the missing required join under separately authorized scope.
- Configured event schema/source, current consent/reset/session/local queues and canonical normalization; public key never read/truth authority; quota/receipt/work fence and 30-day identifier disposal with safe replay tombstone. Real SDK and Analytics consumer proof.
- Declared dependencies: `finished-product:FP.REPORTS`, `finished-product:FP.LIFETIME`, `challenge:T24`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Configured event schema/source, current consent/reset/session/local queues and canonical normalization; public key never read/truth authority; quota/receipt/work fence and 30-day identifier disposal with safe replay tombstone. Real SDK and Analytics consumer proof.
- Defining-owner paths from the old plan: `packages/services/src/analytics/tracker.ts`, `packages/ui/src/tracker/client.ts`, `packages/ui/src/tracker/consent.ts`, `packages/ui/src/tracker/session.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: The finished-product list records this required join as a new proposed packet; the current scoped consolidation provides no implementation or end-to-end acceptance for it.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.INVOCATION — Complete finite approved invocation value and protected actions

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.INVOCATION` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- Complete normalized args/version/ref provenance and request allowlist; currently readable protected preview, approval + effects in same owner transaction and post-call invariant rollback; actual Workbench Task.update/complete and negative roles/version cases. No string dispatcher or alternate execute API.
- Declared dependencies: `challenge:T04`, `challenge:T15`, `challenge:T16`, `challenge:T32`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Complete normalized args/version/ref provenance and request allowlist; currently readable protected preview, approval + effects in same owner transaction and post-call invariant rollback; actual Workbench Task.update/complete and negative roles/version cases. No string dispatcher or alternate execute API.
- Defining-owner paths from the old plan: `packages/services/src/models/invocations.ts`, `packages/interfaces/src/projection/invocations.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.APP-ADJUDICATION — Resolve source/companion correspondence at exact sites

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.APP-ADJUDICATION` · REQUIRED
- Obtain exact source-owner verdicts for Mail, Reception, Rent, Discover, Catch, Affiliate, Event and Stock; preserve source intent, countercases, uncertainty, deliberate negatives and adopted policy before any source correction.
- Declared dependencies: `challenge:T02`, `challenge:T36`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Separate explicit desired policy from source defect, missing implementation and deliberate negative. Resolve Mail frozen latest address dispatch, Reception fresh repeat result/contextual guest destination, Rent historical day facts/denominator, Discover committed hook, Catch cumulative/daily meaning and Affiliate cancellation qualification, Event public availability authority and Stock single-leg reversal versus paired transfer conservation; preserve opposing evidence/uncertainty. This packet requests owner verdicts before any draft correction, not invented source policy.
- Defining-owner paths from the old plan: `draft/CanMail.can`, `draft/CanReception.can`, `draft/CanRent.can`, `draft/CanDiscover.can`, `draft/CanCatch.can`, `draft/CanAffiliate.can`, `draft/CanEvent.can`, `draft/CanStock.can`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Shared findings and app reviews preserve exact unresolved source/companion conflicts; current draft descendant is retained without automatic correction.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.SOURCE-CLOSURE — Close outstanding deep source and mixed-duty review

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.SOURCE-CLOSURE` · REQUIRED
- Finish accumulated-delta body/control-flow and independent test-expectation review, including oversized and mixed-duty owners; reconcile exact caller/authority/failure/termination scope and update checkpoint only after complete review.
- Declared dependencies: `challenge:T02`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Review remaining body/control-flow/test expectation scope in accumulated delta and oversized catalogs; independent challenger records real caller/authority/failure/termination and each mixed-duty owner. Structural symbols/counts alone never close source review or advance checkpoint.
- Defining-owner paths from the old plan: `docs/ideal-filetree-plan/finished-product/requirements.json`, `docs/ideal-filetree-plan/finished-product/findings.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Consolidation catalogs every current path and preserves scoped historical review, but explicitly marks FP.SOURCE-CLOSURE open and checkpoint 8249342 unchanged.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.AW-MAILBOX — Receive authenticated MIME and produce bounded passive IncomingEmail with honest original attachment count/completeness; reply frozen MailReply, source-based reconcile without send, prove terminal not_sent disallows later original send.

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.AW-MAILBOX` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- packages/contracts/src/services.ts:933,961,987,1163 current contract retained; existing EmailV1 adapter retained send-only, not repurposed as mailbox; provider API/credential choice remains specific pending mechanism. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Declared dependencies: `finished-product:FP.MAILBOX`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: packages/contracts/src/services.ts:933,961,987,1163 current contract retained; existing EmailV1 adapter retained send-only, not repurposed as mailbox; provider API/credential choice remains specific pending mechanism. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Defining-owner paths from the old plan: `packages/services/src/mailbox/ingress.ts`, `packages/services/src/mailbox/mime.ts`, `packages/services/src/mailbox/reply.ts`, `packages/services/src/mailbox/reconcile.ts`, `packages/cloudflare/src/runtime/providers/mailbox.ts`, `packages/testkit/src/fixtures/mailbox.ts`, `packages/services/src/standard/mailbox.ts`, `packages/cloudflare/src/runtime/work/providers.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/ideal-filetree-plan/finished-product/reviews/apps-work.json](../../docs/ideal-filetree-plan/finished-product/reviews/apps-work.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.AW-PAYMENTS — Verified account/provider event and original attempt/amount/currency/revision, mandate consent evidence, checkout cancel fence, exact refund identity and original reconciliation; late real funds retained not fabricated transient failure.

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.AW-PAYMENTS` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- packages/contracts/src/services.ts:209,221,230,241,246 existing retained wire contract; catalog.ts current lists no payment adapter. Concrete provider/account transport choice pending; required semantics adopted. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Declared dependencies: `finished-product:FP.SOURCE-MAPPINGS`, `challenge:T24`, `finished-product:FP.COMPILED-DECIMAL`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: packages/contracts/src/services.ts:209,221,230,241,246 existing retained wire contract; catalog.ts current lists no payment adapter. Concrete provider/account transport choice pending; required semantics adopted. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Defining-owner paths from the old plan: `packages/services/src/payments/collect.ts`, `packages/services/src/payments/refund.ts`, `packages/services/src/payments/cancel.ts`, `packages/services/src/payments/reconcile.ts`, `packages/services/src/payments/events.ts`, `packages/cloudflare/src/runtime/providers/payments.ts`, `packages/testkit/src/fixtures/payments.ts`, `packages/cloudflare/src/runtime/work/providers.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/ideal-filetree-plan/finished-product/reviews/apps-work.json](../../docs/ideal-filetree-plan/finished-product/reviews/apps-work.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.AW-DOCUMENTS — Generate immutable original issued/receipt snapshot PDF with exact source/revision, bounded bytes/finalized receiving file and current download grant. No success from missing/wrong artifact.

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.AW-DOCUMENTS` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- Retain app-owned DocumentsV1 signature and files provenance/finalization; renderer/provider remains pending implementation choice, do not add authored per-app manifest. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Declared dependencies: `finished-product:FP.SOURCE-MAPPINGS`, `finished-product:FP.FILES-DURABLE`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Retain app-owned DocumentsV1 signature and files provenance/finalization; renderer/provider remains pending implementation choice, do not add authored per-app manifest. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Defining-owner paths from the old plan: `packages/services/src/documents/render.ts`, `packages/services/src/documents/finalize.ts`, `packages/cloudflare/src/runtime/providers/documents.ts`, `packages/testkit/src/fixtures/documents.ts`, `packages/cloudflare/src/runtime/work/providers.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/ideal-filetree-plan/finished-product/reviews/apps-work.json](../../docs/ideal-filetree-plan/finished-product/reviews/apps-work.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.AW-SOURCE-CONNECTOR — Reusable installed cross-app binding authenticates permitted producer+selected app/team/customer/resource/source namespace and operation/request digest; correlate only matching committed outcome to original delivery; map source domain change separately, preserve nullable absence and precreation fences. Receiver-generated canonical operation still owns business authority/state.

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.AW-SOURCE-CONNECTOR` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- Retain contracts/services.ts versioned capability shapes and existing work intents/receipts. No app-specific Rust membership/booking reducer, no extra writable mirror, no state->full-work dependency. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Declared dependencies: `finished-product:FP.SOURCE-MAPPINGS`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Retain contracts/services.ts versioned capability shapes and existing work intents/receipts. No app-specific Rust membership/booking reducer, no extra writable mirror, no state->full-work dependency. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Defining-owner paths from the old plan: `packages/cloudflare/src/runtime/providers/source-bindings.ts`, `packages/cloudflare/src/runtime/providers/source-ingress.ts`, `packages/cloudflare/src/runtime/providers/source-outcomes.ts`, `packages/cloudflare/src/runtime/providers/source-events.ts`, `packages/testkit/src/fixtures/source-bindings.ts`, `packages/cloudflare/src/runtime/work/providers.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/ideal-filetree-plan/finished-product/reviews/apps-work.json](../../docs/ideal-filetree-plan/finished-product/reviews/apps-work.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.AW-ONBOARD-HANDOFF — Generated canonical onboard.start with genuine HR caller + exact employee/template/candidate verified match and once-only handoff reference; authorized course progress delegated without staff grants or private CV copy.

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.AW-ONBOARD-HANDOFF` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- Existing state defining files retained, source binding new as above; application operation remains owning CanOnboard declaration; no new host onboarding policy kernel. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Declared dependencies: `finished-product:FP.SOURCE-MAPPINGS`, `finished-product:FP.IDENTITY`, `challenge:T16`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Existing state defining files retained, source binding new as above; application operation remains owning CanOnboard declaration; no new host onboarding policy kernel. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Defining-owner paths from the old plan: `packages/state/src/invocation/admission.ts`, `packages/state/src/invocation/invoke.ts`, `packages/cloudflare/src/runtime/providers/source-bindings.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/ideal-filetree-plan/finished-product/reviews/apps-work.json](../../docs/ideal-filetree-plan/finished-product/reviews/apps-work.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.AW-JUDGMENT — Exact Triage specification/model/output association; validate every probability/option/level and decimal normalization/expectation bounds with no argmax substitution, current progress and budget semantics.

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.AW-JUDGMENT` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- Retain contracts judgment shapes and services/judgments/systemone.ts harness adapter; declaration compile/lowering and real producer remain required cross-owner gate. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Declared dependencies: `challenge:T12`, `challenge:T13`, `challenge:T24`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Retain contracts judgment shapes and services/judgments/systemone.ts harness adapter; declaration compile/lowering and real producer remain required cross-owner gate. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Defining-owner paths from the old plan: `packages/services/src/judgments/normalize.ts`, `packages/cloudflare/src/runtime/providers/judgments.ts`, `packages/testkit/src/fixtures/judgments.ts`, `packages/cloudflare/src/runtime/work/providers.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/ideal-filetree-plan/finished-product/reviews/apps-work.json](../../docs/ideal-filetree-plan/finished-product/reviews/apps-work.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### FP.AW-REPLAY-IMPORT — CSV confirmed per-row canonical replay-safe intake with current reference/file authority, retained unknown/failed/excluded rows and honest completion; historical nullable facts never invoke current settlement/approval.

- [ ] **Partly implemented / incomplete acceptance** · `finished-product:FP.AW-REPLAY-IMPORT` · REQUIRED
- Complete the owner-released source-derived join and qualify its full required current-authority, retry/recovery, failure and termination behavior.
- Join selected P-CSV ui parse/preview/confirm + interfaces HTTP adapter and canonical owner admission; no new presentation package or alternate coordinator. Confirm rows through one current canonical replay-safe operation path. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Declared dependencies: `finished-product:FP.CSV`, `finished-product:FP.FILES-DURABLE`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Join selected P-CSV ui parse/preview/confirm + interfaces HTTP adapter and canonical owner admission; no new presentation package or alternate coordinator. Confirm rows through one current canonical replay-safe operation path. Full app-specific cause/retry/current-authority/termination and actual installed producer negatives remain required.
- Defining-owner paths from the old plan: `packages/ui/src/csv/parse.ts`, `packages/ui/src/csv/preview.ts`, `packages/ui/src/csv/confirm.ts`, `packages/interfaces/src/http/csv.ts`, `packages/testkit/src/fixtures/csv-intake.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Owning declarations/wire contracts or core APIs exist at recorded review scope; the actual required end-to-end producer/consumer/durable acceptance remains unqualified.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/ideal-filetree-plan/finished-product/reviews/apps-work.json](../../docs/ideal-filetree-plan/finished-product/reviews/apps-work.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

## documentation

## Conditional or deferred — documentation

### DOC03 — Close and consolidate superseded living-plan prose

- [ ] **Not implemented / no execution evidence** · `documentation:DOC03` · ACCEPTED-CONDITIONAL
- Apply the exact content/owner/reconstruction/live-reference gates if this accepted conditional or deferred scope is selected; preserve active coordinator and historical evidence until owning handoff.
- Compare unique prior baseline, source-review, decisions and scheduling duties against the selected finished plan; one current navigation authority, merge compatible prior scheduling sections and retire duplicate prose only after a named successor and all references are reconciled. Moving records alone is not file-count reduction.
- Close when: Compare unique prior baseline, source-review, decisions and scheduling duties against the selected finished plan; one current navigation authority, merge compatible prior scheduling sections and retire duplicate prose only after a named successor and all references are reconciled. Moving records alone is not file-count reduction.
- Defining-owner paths from the old plan: `docs/ideal-filetree-plan/baseline.md`, `docs/ideal-filetree-plan/findings.md`, `docs/ideal-filetree-plan/ownership.md`, `docs/ideal-filetree-plan/tasks.md`, `docs/ideal-filetree-plan/desired-tree.md`, `docs/ideal-filetree-plan/slices.md`, `docs/ideal-filetree-plan/lanes.md`, `docs/ideal-filetree-plan/consultations.md`, `docs/ideal-filetree-plan/prior-review.md`, `docs/ideal-filetree-plan/finished-product/findings.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Explicit conditional/deferred documentation work, no executed cutover; do not impose a global product barrier.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/documentation-review.json](../../docs/ideal-filetree-plan/finished-product/documentation-review.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### DOC04 — Centralize shared developer setup and test navigation

- [ ] **Not implemented / no execution evidence** · `documentation:DOC04` · ACCEPTED-CONDITIONAL
- Apply the exact content/owner/reconstruction/live-reference gates if this accepted conditional or deferred scope is selected; preserve active coordinator and historical evidence until owning handoff.
- One shared install/build/test-navigation owner; retain package APIs, architecture/failure boundaries and browser-specific limitations. Compare authoring-demo versus compiler README before choosing merge or retention; update stale claims from owning current evidence, never infer whole-app qualification.
- Close when: One shared install/build/test-navigation owner; retain package APIs, architecture/failure boundaries and browser-specific limitations. Compare authoring-demo versus compiler README before choosing merge or retention; update stale claims from owning current evidence, never infer whole-app qualification.
- Defining-owner paths from the old plan: `docs/dev-setup.md`, `docs/install.md`, `docs/e2e.md`, `docs/authoring-demo.md`, `compiler/README.md`, `tests/integration/README.md`, `packages/cloudflare/README.md`, `packages/contracts/README.md`, `packages/files/README.md`, `packages/identity/README.md`, `packages/interfaces/README.md`, `packages/services/README.md`, `packages/state/README.md`, `packages/stdlib/README.md`, `packages/testkit/README.md`, `packages/ui/README.md`, `packages/values/README.md`, `packages/work/README.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Explicit conditional/deferred documentation work, no executed cutover; do not impose a global product barrier.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/documentation-review.json](../../docs/ideal-filetree-plan/finished-product/documentation-review.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### DOC05 — Consolidate obsolete implementation launch and steering prose after owner handoff

- [ ] **Not implemented / no execution evidence** · `documentation:DOC05` · ACCEPTED-CONDITIONAL
- Apply the exact content/owner/reconstruction/live-reference gates if this accepted conditional or deferred scope is selected; preserve active coordinator and historical evidence until owning handoff.
- Current remaining checklist, active contracts, source reservations and unreleased obligations stay live. Transfer unique scope/corrections to the owning brief or accepted task; remove obsolete launch pointers only after no live/paste caller needs them. The implementation run is stopped; preserve unfinished tasks/contracts/evidence and require a later actual owner handoff before retiring their launch or steering records.
- Close when: Current remaining checklist, active contracts, source reservations and unreleased obligations stay live. Transfer unique scope/corrections to the owning brief or accepted task; remove obsolete launch pointers only after no live/paste caller needs them. The implementation run is now stopped; preserve its unfinished tasks/contracts/evidence and require an actual later owner handoff before retiring their launch or steering records.
- Defining-owner paths from the old plan: `implementation/PLAN.md`, `implementation/WORKFLOW.md`, `implementation/UI-CATALOG-ADOPTION.md`, `implementation/DESIGN-DELTA-20261004.md`, `implementation/D3B-PRODUCTION-QUAL-PLAN.md`, `implementation/prompts/05-ui.md`, `implementation/prompts/05-ui-steering.md`, `implementation/briefs/05-ui.md`, `implementation/prompts/08-frontend-catalog-migration.md`, `implementation/prompts/08-frontend-catalog-steering.md`, `implementation/briefs/08-frontend-catalog-migration.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Explicit conditional/deferred documentation work, no executed cutover; do not impose a global product barrier.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/documentation-review.json](../../docs/ideal-filetree-plan/finished-product/documentation-review.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### DOC06 — Specify evidence reconstruction before any snapshot-storage deduplication

- [ ] **Deferred / outside selected required work** · `documentation:DOC06` · DEFERRED
- Apply the exact content/owner/reconstruction/live-reference gates if this accepted conditional or deferred scope is selected; preserve active coordinator and historical evidence until owning handoff.
- Optional later storage proposal only: logical paths, exact bytes, recorded measurements and hashes must reconstruct, with all historical runners/manifest consumers proved. Four exact duplicate sets do not authorize deleting captured files.
- Close when: Optional later storage proposal only: logical paths, exact bytes, recorded measurements and hashes must reconstruct, with all historical runners/manifest consumers proved. Four exact duplicate sets do not authorize deleting captured files.
- Source: [docs/ideal-filetree-plan/finished-product/tasks.json](../../docs/ideal-filetree-plan/finished-product/tasks.json)
- Current basis: Explicit conditional/deferred documentation work, no executed cutover; do not impose a global product barrier.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/documentation-review.json](../../docs/ideal-filetree-plan/finished-product/documentation-review.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.
