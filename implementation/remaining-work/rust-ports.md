# Rust ports and shared delivery gates

Reconciled against main `7fd8c6b` on 2026-10-06. [Index](../REMAINING-WORK.md) · [Exact ledger](tasks.json).

Only unresolved tasks are listed below. Completed narrow tasks are retained in the exact ledger and are not assigned again. All workers remain stopped; D’s port remains human-held. Conditional/deferred rows are separate from selected required work.

## artifact-preparation

## Required remaining — artifact-preparation

### P04.1 — Port artifact semantic indexes and identity checks

- [ ] **Acceptance evidence missing** · `ports:P04.1` · REQUIRED
- On explicit human resume, review the retained mechanism/trace/bytes/error-order branch against original source and record scoped acceptance; full native host job/CLI remains downstream.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P03.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Source fixtures and multiple-error first-failure order match; malformed JSON remains a host parse error.
- Defining-owner paths from the old plan: `packages/cloudflare/preparation/src/artifact.rs`, `packages/cloudflare/preparation/tests/artifact.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Rust artifact/compatibility/release/module/plan/render/review algorithms and prefix join, plus real TS host phase adapter copies, are retained and code-review READY; audit ran 204 native tests. Coordinator branch acceptance remains pending under human HOLD.
- Scoped evidence: [packages/cloudflare/preparation/src/artifact.rs](../../packages/cloudflare/preparation/src/artifact.rs), [packages/cloudflare/preparation/tests/artifact.rs](../../packages/cloudflare/preparation/tests/artifact.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/preparation/src/lib.rs](../../packages/cloudflare/preparation/src/lib.rs), [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [packages/cloudflare/src/preparation/build-adapter.ts](../../packages/cloudflare/src/preparation/build-adapter.ts), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P04.2 — Port ordered compatibility calculations

- [ ] **Acceptance evidence missing** · `ports:P04.2` · REQUIRED
- On explicit human resume, review the retained mechanism/trace/bytes/error-order branch against original source and record scoped acceptance; full native host job/CLI remains downstream.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P03.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Accepted pre-release cases, missing secret names and reason ordering match; no new capability/version authority.
- Defining-owner paths from the old plan: `packages/cloudflare/preparation/src/compatibility.rs`, `packages/cloudflare/preparation/tests/compatibility.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Rust artifact/compatibility/release/module/plan/render/review algorithms and prefix join, plus real TS host phase adapter copies, are retained and code-review READY; audit ran 204 native tests. Coordinator branch acceptance remains pending under human HOLD.
- Scoped evidence: [packages/cloudflare/preparation/src/compatibility.rs](../../packages/cloudflare/preparation/src/compatibility.rs), [packages/cloudflare/preparation/tests/compatibility.rs](../../packages/cloudflare/preparation/tests/compatibility.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/preparation/src/lib.rs](../../packages/cloudflare/preparation/src/lib.rs), [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [packages/cloudflare/src/preparation/build-adapter.ts](../../packages/cloudflare/src/preparation/build-adapter.ts), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P04.3 — Port release manifest and stamp calculations

- [ ] **Acceptance evidence missing** · `ports:P04.3` · REQUIRED
- On explicit human resume, review the retained mechanism/trace/bytes/error-order branch against original source and record scoped acceptance; full native host job/CLI remains downstream.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P03.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Byte hashes, counts, sorting and mismatch order match; host remains the filesystem/release-fact authority.
- Defining-owner paths from the old plan: `packages/cloudflare/preparation/src/release.rs`, `packages/cloudflare/preparation/tests/release.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Rust artifact/compatibility/release/module/plan/render/review algorithms and prefix join, plus real TS host phase adapter copies, are retained and code-review READY; audit ran 204 native tests. Coordinator branch acceptance remains pending under human HOLD.
- Scoped evidence: [packages/cloudflare/preparation/src/release.rs](../../packages/cloudflare/preparation/src/release.rs), [packages/cloudflare/preparation/tests/release.rs](../../packages/cloudflare/preparation/tests/release.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/preparation/src/lib.rs](../../packages/cloudflare/preparation/src/lib.rs), [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [packages/cloudflare/src/preparation/build-adapter.ts](../../packages/cloudflare/src/preparation/build-adapter.ts), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P04.4 — Join acceptance and compatibility into native job

- [ ] **Acceptance evidence missing** · `ports:P04.4` · REQUIRED
- On explicit human resume, review the retained mechanism/trace/bytes/error-order branch against original source and record scoped acceptance; full native host job/CLI remains downstream.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P03`, `ports:P04.1`, `ports:P04.2`, `ports:P04.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Full stage traces retain early refusal points and the distinction between preview compiler warning and confirmed refusal before publication.
- Defining-owner paths from the old plan: `packages/cloudflare/preparation/src/job.rs`, `packages/cloudflare/preparation/tests/vectors.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Rust artifact/compatibility/release/module/plan/render/review algorithms and prefix join, plus real TS host phase adapter copies, are retained and code-review READY; audit ran 204 native tests. Coordinator branch acceptance remains pending under human HOLD.
- Scoped evidence: [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [packages/cloudflare/preparation/tests/vectors.rs](../../packages/cloudflare/preparation/tests/vectors.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/preparation/src/lib.rs](../../packages/cloudflare/preparation/src/lib.rs), [packages/cloudflare/src/preparation/build-adapter.ts](../../packages/cloudflare/src/preparation/build-adapter.ts), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P04 — Artifact, identity, compatibility and release core complete

- [ ] **Human-held** · `ports:P04` · REQUIRED
- On explicit human resume, close source/first-error/real stage-prefix review for P04.1-P04.4 and record the precise native prefix scope; no full host/CLI claim.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P04.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Native vectors match source fixtures and first-error order; malformed host JSON still follows host diagnostics. Dist file hashes/counts and all mismatch lines match existing raw-byte behavior. No new release/capability authority.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P04.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: P04 inputs are code-review READY and real Rust prefix exists; coordinator completion review remains pending under explicit human HOLD.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P05.1 — Port module inventory, rewriting and graph checks

- [ ] **Acceptance evidence missing** · `ports:P05.1` · REQUIRED
- On explicit human resume, review the retained mechanism/trace/bytes/error-order branch against original source and record scoped acceptance; full native host job/CLI remains downstream.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P04.1`, `ports:P02.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: JS-only keys/text/markers/v1 hashes and current string.length counts match; unresolved/bare imports retain refusal; no binary decoding as JS.
- Defining-owner paths from the old plan: `packages/cloudflare/preparation/src/modules.rs`, `packages/cloudflare/preparation/tests/modules.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Rust artifact/compatibility/release/module/plan/render/review algorithms and prefix join, plus real TS host phase adapter copies, are retained and code-review READY; audit ran 204 native tests. Coordinator branch acceptance remains pending under human HOLD.
- Scoped evidence: [packages/cloudflare/preparation/src/modules.rs](../../packages/cloudflare/preparation/src/modules.rs), [packages/cloudflare/preparation/tests/modules.rs](../../packages/cloudflare/preparation/tests/modules.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/preparation/src/lib.rs](../../packages/cloudflare/preparation/src/lib.rs), [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [packages/cloudflare/src/preparation/build-adapter.ts](../../packages/cloudflare/src/preparation/build-adapter.ts), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P05.2 — Produce two-phase real build-adapter contract

- [ ] **Acceptance evidence missing** · `ports:P05.2` · REQUIRED
- On explicit human resume, review the retained mechanism/trace/bytes/error-order branch against original source and record scoped acceptance; full native host job/CLI remains downstream.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P02.2`, `ports:P03.4`, `ports:P02.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Requests preserve module/page checks before worker probe, vendor outputs before Bun, verdict render before catalog and loadability before links; legacy worker-missing path invokes neither phase.
- Defining-owner paths from the old plan: `packages/cloudflare/src/preparation/build-adapter.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/bundle-join-request.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Rust artifact/compatibility/release/module/plan/render/review algorithms and prefix join, plus real TS host phase adapter copies, are retained and code-review READY; audit ran 204 native tests. Coordinator branch acceptance remains pending under human HOLD.
- Scoped evidence: [packages/cloudflare/src/preparation/build-adapter.ts](../../packages/cloudflare/src/preparation/build-adapter.ts), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/bundle-join-request.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/bundle-join-request.json), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/preparation/src/lib.rs](../../packages/cloudflare/preparation/src/lib.rs), [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P05.3 — Integrate real host build phases

- [ ] **Human-held** · `ports:P05.3` · REQUIRED
- On explicit human resume, consume reviewed owning bundle builder exports and delete adapter copies.
- Implement real native host stages and artifact_path Begin handoff; prove each Bun/catalog/external stage executes once in original order.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P05.1`, `ports:P05.2`, `ports:C04.preparation-join`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No mocked host outputs count as Bun/catalog integration evidence; each external stage occurs once at its current position.
- Defining-owner paths from the old plan: `packages/cloudflare/src/preparation/build-adapter.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Shared bundle builders are now exported, but build-adapter.ts still contains pinned private copies; host runNativeJob/driver is scaffold-only. Old missing-producer blocker is superseded.
- Scoped evidence: [packages/cloudflare/src/preparation/build-adapter.ts](../../packages/cloudflare/src/preparation/build-adapter.ts), [packages/cloudflare/src/deploy/bundle.ts](../../packages/cloudflare/src/deploy/bundle.ts), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/preparation/protocol.ts](../../packages/cloudflare/src/preparation/protocol.ts), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P05.4 — Join module buffers and host resumes in native job

- [ ] **Human-held** · `ports:P05.4` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P04.4`, `ports:P05.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Matching legacy-main fallback, cross-stage identities, ordered failures and full module output pass differential tests.
- Defining-owner paths from the old plan: `packages/cloudflare/preparation/src/job.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P05.5 — Prove JS-only bundle and real MCP output

- [ ] **Human-held** · `ports:P05.5` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P05.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Real MCP output runs; marker-only checks are insufficient; JS-only bundle bytes/digests match without requiring a Wasm-loader proof.
- Defining-owner paths from the old plan: `packages/cloudflare/test/preparation-native.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/module-parity.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P05 — Native module graph and ordered host build complete

- [ ] **Human-held** · `ports:P05` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P05.5`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Same JS text, imports, markers, key order and v1 digest for existing fixtures. Negative unresolved/bare imports preserve refusals. Real MCP output works in local workerd, not only text-marker tests. C04 is required only for mixed Wasm inventory acceptance. The mixed-asset acceptance remains an explicit P05.mixed outcome gate joined at P11: enabled mixed support requires P05.6 proof; JS-only completion records mixed support as deferred and does not certify it.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P05.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P05.mixed — Review enabled mixed-asset proof or declared JS-only limit

- [ ] **Human-held** · `ports:P05.mixed` · REQUIRED
- On explicit human resume, record enabled mixed preparation with P05.6 proof or JS-only declared limit and pre-evaluation unsupported-mixed refusal; leave conditional branch open if deferred.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P05.5`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Enabled mixed support requires P05.6 real-byte/loader/installed-output evidence; JS-only completion records deferred mixed support, rejects unsupported mixed input before native evaluation, and never claims Wasm adoption.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P05.mixed.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Required mixed-outcome review remains unrecorded. Conditional mixed proof is separate; generic binary carrier/smoke does not certify preparation support.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P06.1 — Port resource and deploy-plan calculations

- [ ] **Acceptance evidence missing** · `ports:P06.1` · REQUIRED
- On explicit human resume, review the retained mechanism/trace/bytes/error-order branch against original source and record scoped acceptance; full native host job/CLI remains downstream.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P04.1`, `ports:P04.2`, `ports:P02.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Plan objects, resource order and all source refusal cases match; this branch does not await full module implementation.
- Defining-owner paths from the old plan: `packages/cloudflare/preparation/src/plan.rs`, `packages/cloudflare/preparation/tests/plan.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Rust artifact/compatibility/release/module/plan/render/review algorithms and prefix join, plus real TS host phase adapter copies, are retained and code-review READY; audit ran 204 native tests. Coordinator branch acceptance remains pending under human HOLD.
- Scoped evidence: [packages/cloudflare/preparation/src/plan.rs](../../packages/cloudflare/preparation/src/plan.rs), [packages/cloudflare/preparation/tests/plan.rs](../../packages/cloudflare/preparation/tests/plan.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/preparation/src/lib.rs](../../packages/cloudflare/preparation/src/lib.rs), [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [packages/cloudflare/src/preparation/build-adapter.ts](../../packages/cloudflare/src/preparation/build-adapter.ts), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P06.2 — Port exact JSON/TOML rendering and review

- [ ] **Acceptance evidence missing** · `ports:P06.2` · REQUIRED
- On explicit human resume, review the retained mechanism/trace/bytes/error-order branch against original source and record scoped acceptance; full native host job/CLI remains downstream.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P06.1`, `ports:P03.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Complete bytes match host JSON.stringify/current TOML; nonfinite→null/negative-zero and unknown previous-plan cases pass; no generic serializer parity assumption.
- Defining-owner paths from the old plan: `packages/cloudflare/preparation/src/render.rs`, `packages/cloudflare/preparation/src/review.rs`, `packages/cloudflare/preparation/tests/outputs.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Rust artifact/compatibility/release/module/plan/render/review algorithms and prefix join, plus real TS host phase adapter copies, are retained and code-review READY; audit ran 204 native tests. Coordinator branch acceptance remains pending under human HOLD.
- Scoped evidence: [packages/cloudflare/preparation/src/render.rs](../../packages/cloudflare/preparation/src/render.rs), [packages/cloudflare/preparation/src/review.rs](../../packages/cloudflare/preparation/src/review.rs), [packages/cloudflare/preparation/tests/outputs.rs](../../packages/cloudflare/preparation/tests/outputs.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/preparation/src/lib.rs](../../packages/cloudflare/preparation/src/lib.rs), [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [packages/cloudflare/src/preparation/build-adapter.ts](../../packages/cloudflare/src/preparation/build-adapter.ts), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P06.3 — Join plan, prior-plan request and rendered review

- [ ] **Human-held** · `ports:P06.3` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P05.4`, `ports:P06.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Repeated jobs are deterministic; missing/bad prior plans fail at existing stages; preview+yes still previews; confirmed mismatch refuses after preparation and before writes.
- Defining-owner paths from the old plan: `packages/cloudflare/preparation/src/job.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [packages/cloudflare/preparation/src/job.rs](../../packages/cloudflare/preparation/src/job.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P06 — Plan, rendering and review integration complete

- [ ] **Human-held** · `ports:P06` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P06.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Byte-identical JS-only outputs and reason/diff ordering; preserve unknown fields where today's previous-plan/render path admits them. Repeated jobs deterministically yield the same result. A generic TOML/JSON library's output is insufficient evidence.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P06.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P07.1 — Implement contained staging and publication adapter

- [ ] **Human-held** · `ports:P07.1` · REQUIRED
- On explicit human resume, verify actual staged bytes/hash/length against retained reviewed buffers at publication, and prove on-disk mutation is rejected before writes.
- Complete cleanup/every-exit/partial-write and exact reviewed apply handoff proof without live deployment.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P03.4`, `ports:P06.2`, `ports:C03.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Cleanup on every exit is tested; private preview staging is allowed but no deployment file publication; current partial-write behavior is classified honestly.
- Defining-owner paths from the old plan: `packages/cloudflare/src/preparation/publication.ts`, `packages/cloudflare/test/preparation-publication.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Contained staging/publication adapter and tests exist, but verifyReviewed compares reviewed buffers with stale recorded metadata and publish rereads unchecked disk bytes: staged-byte mutation can be shipped. HUMAN HOLD remains.
- Scoped evidence: [packages/cloudflare/src/preparation/publication.ts](../../packages/cloudflare/src/preparation/publication.ts), [packages/cloudflare/test/preparation-publication.test.ts](../../packages/cloudflare/test/preparation-publication.test.ts), [packages/cloudflare/src/preparation/publication.ts:255](../../packages/cloudflare/src/preparation/publication.ts), [packages/cloudflare/src/preparation/publication.ts:300](../../packages/cloudflare/src/preparation/publication.ts), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P07.2 — Verify actual job publication and mocked apply

- [ ] **Human-held** · `ports:P07.2` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P05`, `ports:P06`, `ports:P07.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Zero deployment files for bare/preview/mismatch; mocked apply consumes exactly reviewed bundle/config; no live deploy.
- Defining-owner paths from the old plan: `packages/cloudflare/test/preparation-cli.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/publication.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P07 — Staging, reviewed-write identity and apply handoff complete

- [ ] **Human-held** · `ports:P07` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P03`, `ports:P05`, `ports:P06`, `ports:P07.1`, `ports:P07.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Preview and bare deploy publish zero deployment files; compiler mismatch writes none; successful mocked apply sees the exact reviewed config/bundle. Existing failed-apply envelope/manual command and partial-write behavior remain honestly classified. No live deploy.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P07.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P08.1 — Join native build/preview/confirmed CLI selection

- [ ] **Human-held** · `ports:P08.1` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P07`, `ports:P02.2`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Exactly one stdout envelope, matching exits/code/detail/stderr and no repeated external stages; selected-native startup failure is visible.
- Defining-owner paths from the old plan: `packages/cloudflare/src/cli/platform.ts`, `packages/cloudflare/src/preparation/host.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P08.2 — Run full CLI and installed-dist differential

- [ ] **Human-held** · `ports:P08.2` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P08.1`, `ports:P02.3`, `ports:C04.native-release`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No unexplained traces/bytes/errors; library helper routes remain declared and passing.
- Defining-owner paths from the old plan: `packages/cloudflare/conformance/preparation/differential.mjs`, `packages/cloudflare/test/preparation-cli.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/cli-parity.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [packages/cloudflare/conformance/preparation/differential.mjs](../../packages/cloudflare/conformance/preparation/differential.mjs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P08 — Actual native CLI consumer complete

- [ ] **Human-held** · `ports:P08` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P08.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: One stdout envelope, matching exits/code/detail/stderr review and no repeated external stages. Run real native executable and generated installed `dist`, not mocked native replies. Public synchronous library helper tests still pass on their declared routes.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P08.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P09.1 — Build native packaging scripts and host inventory early

- [ ] **Partly implemented / incomplete acceptance** · `ports:P09.1` · REQUIRED
- Review supported host claims and package request; complete prebuilt executable/notices/dist/command integration with C04.native-release; installed launches remain P09.2.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P03.foundation`, `ports:P01.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Supported hosts derive from claims/consumers; normal installation will use prebuilt executables; scripts do not vendor native binaries into Workers.
- Defining-owner paths from the old plan: `packages/cloudflare/scripts/build-preparation.mjs`, `packages/cloudflare/scripts/package-preparation.mjs`, `packages/cloudflare/src/preparation/executable-manifest.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/native-release-request.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native build/package scripts, host manifest and submitted release request exist; no accepted release integrator join or supported prebuilt installed launch proof.
- Scoped evidence: [packages/cloudflare/scripts/build-preparation.mjs](../../packages/cloudflare/scripts/build-preparation.mjs), [packages/cloudflare/scripts/package-preparation.mjs](../../packages/cloudflare/scripts/package-preparation.mjs), [packages/cloudflare/src/preparation/executable-manifest.ts](../../packages/cloudflare/src/preparation/executable-manifest.ts), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/native-release-request.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/native-release-request.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P09.2 — Prove supported packaged executable launch

- [ ] **Human-held** · `ports:P09.2` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P08`, `ports:P09.1`, `ports:C04.native-release`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Each supported host has actual build+launch evidence; unsupported hosts remain explicit; package includes executable/license/dist metadata and needs no user compiler.
- Defining-owner paths from the old plan: `packages/cloudflare/test/preparation-packaged.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/packaged-hosts.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P09 — Native build, publication and supported-host proof complete

- [ ] **Human-held** · `ports:P09` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P09.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Supported hosts actually build and launch packaged artifacts; wrong architecture, missing executable, corruption, release/protocol skew fail before jobs. Normal users do not require a compiler to install the built package. Native binary is not vendored into Workers.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P09.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P10.1 — Measure full-job adoption and resource budgets

- [ ] **Human-held** · `ports:P10.1` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P08`, `ports:P09`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Recorded complete-call budgets pass or a concrete native consumer/reuse reason with explicit costs justifies adoption; no isolated-core speed claim.
- Defining-owner paths from the old plan: `packages/cloudflare/conformance/preparation/workloads.mjs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/measurement.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [packages/cloudflare/conformance/preparation/workloads.mjs](../../packages/cloudflare/conformance/preparation/workloads.mjs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P10.2 — Rehearse fixed release mode and rollback

- [ ] **Human-held** · `ports:P10.2` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P10.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Rollback requires no persisted-data conversion; integrity failures never start a second implementation; evidence identifies rollout/default choice.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/rollback.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P10 — Measured adoption and rollback decision complete

- [ ] **Human-held** · `ports:P10` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P10.1`, `ports:P10.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Meets the precommitted workload/release budget or records the concrete native consumer/reuse reason. Small previews include subprocess startup. TS rollback does not require artifact, manifest or persisted plan conversion.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P10.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P11.1 — Close package coverage and final release ledger

- [ ] **Human-held** · `ports:P11.1` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P10`, `ports:P05.mixed`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All planned mechanisms and gaps are classified; duplicate TS retirement is separate; eventual merge reconciles living filetree without advancing its checkpoint during planning.
- Defining-owner paths from the old plan: `packages/cloudflare/README.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/coverage.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [packages/cloudflare/README.md](../../packages/cloudflare/README.md), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### P11 — Artifact preparation declared scope complete

- [ ] **Human-held** · `ports:P11` · REQUIRED
- On explicit human resume, complete the exact task acceptance after its dependencies, using real retained native job/host/CLI/shipped artifacts and truthful release/rollback/budget/gap evidence.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P11.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Native selected scope, retained host/library paths and any mixed-asset contract change are explicit. Retirement of TS compatibility is separate. Eventual merge handler reconciles the living filetree; this plan does not advance its checkpoint.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P11.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Native module/plan/publication/CLI/packaged-host/performance/rollback/completion joins are downstream of unimplemented real host/job integration and explicit human HOLD; local native/TS tests do not close them.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/blocked-gates.json), [packages/cloudflare/src/preparation/host.ts](../../packages/cloudflare/src/preparation/host.ts), [packages/cloudflare/src/cli/platform.ts](../../packages/cloudflare/src/cli/platform.ts), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

## Conditional or deferred — artifact-preparation

### P05.6 — Verify mixed text/Wasm preparation after loader proof

- [ ] **Not implemented / no execution evidence** · `ports:P05.6` · ACCEPTED-CONDITIONAL
- Only if this release accepts mixed support, prove actual generated installed mixed output lengths/hashes/import rewriting/legacy JS bytes through loader and publication.
- Human hold: The human explicitly kept D’s artifact-preparation port blocked. This read-only inventory does not resume it.
- Declared dependencies: `ports:P05.5`, `ports:C04.ready`, `ports:C04.graph`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Exact lengths/hashes, unchanged JS-only v1 output and no Wasm-as-text rewriting are demonstrated in generated installed output.
- Defining-owner paths from the old plan: `packages/cloudflare/test/preparation-mixed-assets.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/mixed-assets.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json)
- Current basis: Conditional preparation mixed text/Wasm installed-output proof absent; generic C04 carrier smoke is insufficient.
- Scoped evidence: [packages/cloudflare/src/deploy/bundle.ts](../../packages/cloudflare/src/deploy/bundle.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/artifact-preparation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

## exact-values

## Required remaining — exact-values

### A01.1 — Freeze owner, caller and observable-contract inventory

- [ ] **Partly implemented / incomplete acceptance** · `ports:A01.1` · REQUIRED
- Refresh owner/caller/error/order contracts against integrated source; record owner review and explicit supported/retained profiles, including native parity exclusions.
- Declared dependencies: `ports:C01.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All mapped sources have an owner and admitted-input/error/order contract; compiler changes are unnecessary.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/core/contracts.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Owner/export contract inventory and initial baseline exist, but scope.json has no accepted owner approvals and covers a restricted native tranche.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/core/contracts.md](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/core/contracts.md), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/core/scope.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/core/scope.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A01.2 — Nominate complete-call workloads and ratify budgets

- [ ] **Partly implemented / incomplete acceptance** · `ports:A01.2` · REQUIRED
- Nominate actual selected complete consumer/reuse outcome and precommit measured numeric budgets or explicitly disabled evaluation scope before final comparisons.
- Declared dependencies: `ports:A01.1`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A useful consumer/reuse requirement and fixed budgets exist, or a measured disabled prototype is the explicitly scoped outcome.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/workload-contract.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Native tranche prerequisites exist; complete-call/native reuse adoption budgets explicitly deferred to A07+ and never ratified.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/budgets.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/budgets.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A01 — Scope and adoption contract complete

- [ ] **Partly implemented / incomplete acceptance** · `ports:A01` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in exact-values.md; retain explicit supported/retained/deferred scope.
- Every original A01 obligation is reviewed; no broad rollout is required when the nominated benefit disappears.
- Declared dependencies: `ports:A01.1`, `ports:A01.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Every original A01 obligation is reviewed; no broad rollout is required when the nominated benefit disappears.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A02.1 — Capture deterministic raw and observable TS vectors

- [ ] **Partly implemented / incomplete acceptance** · `ports:A02.1` · REQUIRED
- Complete raw/stored-part observation fixtures for erased distinctions and full supported failure/order domains; prove deterministic regeneration with published conformance/v1 unchanged.
- Declared dependencies: `ports:A01`, `ports:C02.ready`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Fixtures include outputs erased by canonical wire text; deterministic regeneration preserves published conformance/v1 unchanged.
- Defining-owner paths from the old plan: `packages/values/conformance/ports/exact/cases.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: 309 fixed cases plus seeded native parity corpus exist; raw observation JSON erases scale -0, excludes lone UTF-16/split-surrogate and host-object boundaries.
- Scoped evidence: [packages/values/conformance/ports/exact/cases.json](../../packages/values/conformance/ports/exact/cases.json), [packages/values/conformance/ports/exact/differential.mjs](../../packages/values/conformance/ports/exact/differential.mjs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A02.2 — Build current/prepared TS observers and differential shell

- [ ] **Partly implemented / incomplete acceptance** · `ports:A02.2` · REQUIRED
- Build and publish current/prepared-TS whole-call baseline/traces/timings independently of native scalar parity; include original errors/parts and oracle limits.
- Declared dependencies: `ports:A02.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Complete raw outputs and traces match the baseline; Decimal.js is secondary value evidence, not a scale/error oracle.
- Defining-owner paths from the old plan: `packages/values/conformance/ports/exact/differential.mjs`, `packages/values/conformance/ports/exact/workloads.mjs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/ts-baseline.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Current-TS/native differential shell exists and historical 3309 comparisons match scoped domain; independently prepared-TS whole-call observer, complete traces and workload measurements are absent.
- Scoped evidence: [packages/values/conformance/ports/exact/differential.mjs](../../packages/values/conformance/ports/exact/differential.mjs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-run-20261006.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-run-20261006.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A02 — Observable numeric baseline ready

- [ ] **Partly implemented / incomplete acceptance** · `ports:A02` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in exact-values.md; retain explicit supported/retained/deferred scope.
- Current/prepared TS comparators and deterministic fixtures satisfy the original A02 acceptance.
- Declared dependencies: `ports:A02.1`, `ports:A02.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Current/prepared TS comparators and deterministic fixtures satisfy the original A02 acceptance.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A03 — Native integer and rounding foundation complete

- [ ] **Partly implemented / incomplete acceptance** · `ports:A03` · REQUIRED
- Close full native arithmetic gate with source/error/order/transport domain review and pinned build/fmt/license ledger; do not imply binding or consumer adoption.
- Declared dependencies: `ports:A03.foundation`, `ports:A03.2`, `ports:A03.3`, `ports:A03.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Run future cargo test --locked --manifest-path packages/values/semantics/Cargo.toml and cargo fmt --manifest-path packages/values/semantics/Cargo.toml -- --check; save pin/build/license evidence and all original A03 raw-arithmetic contracts.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Workspace/native integer/rounding pass locally at scoped pins, but complete original source/admitted-domain and pin/build/license review is not recorded.
- Scoped evidence: [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A04.1 — Port decimal construction, parsing and stored parts

- [ ] **Partly implemented / incomplete acceptance** · `ports:A04.1` · REQUIRED
- Resolve admitted scale -0 stored-part preservation through native representation or proved pre-evaluation TS retention.
- Close all construction/math/ratio failure-order and raw stored-part native coverage independently of canonical JSON text.
- Declared dependencies: `ports:A03.foundation`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Construction/text preserve full coefficient and stored scale; public Decimal makers remain TS authoritative carriers.
- Defining-owner paths from the old plan: `packages/values/semantics/src/numeric/decimal.rs`, `packages/values/semantics/tests/decimal_vectors.rs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/decimal/construction.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Decimal construction/math/ratio code and vectors are integrated, but native u8 stored scale/JSON transport normalize observable -0; parity ledger avoids raw Object.is carrier proof.
- Scoped evidence: [packages/values/semantics/src/numeric/decimal.rs](../../packages/values/semantics/src/numeric/decimal.rs), [packages/values/semantics/tests/decimal_vectors.rs](../../packages/values/semantics/tests/decimal_vectors.rs), [packages/values/semantics/src/representations/numeric.rs](../../packages/values/semantics/src/representations/numeric.rs), [packages/values/bindings/carriers.ts](../../packages/values/bindings/carriers.ts), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A04.2 — Port decimal math and both ratio branches

- [ ] **Partly implemented / incomplete acceptance** · `ports:A04.2` · REQUIRED
- Resolve admitted scale -0 stored-part preservation through native representation or proved pre-evaluation TS retention.
- Close all construction/math/ratio failure-order and raw stored-part native coverage independently of canonical JSON text.
- Declared dependencies: `ports:A04.1`, `ports:A03.2`, `ports:A03.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Every decimal source branch matches value, stored parts and failure precedence.
- Defining-owner paths from the old plan: `packages/values/semantics/src/numeric/decimal.rs`, `packages/values/semantics/tests/decimal_vectors.rs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/decimal/arithmetic.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Decimal construction/math/ratio code and vectors are integrated, but native u8 stored scale/JSON transport normalize observable -0; parity ledger avoids raw Object.is carrier proof.
- Scoped evidence: [packages/values/semantics/src/numeric/decimal.rs](../../packages/values/semantics/src/numeric/decimal.rs), [packages/values/semantics/tests/decimal_vectors.rs](../../packages/values/semantics/tests/decimal_vectors.rs), [packages/values/semantics/src/representations/numeric.rs](../../packages/values/semantics/src/representations/numeric.rs), [packages/values/bindings/carriers.ts](../../packages/values/bindings/carriers.ts), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A04.3 — Port currency and basic money operations

- [ ] **Partly implemented / incomplete acceptance** · `ports:A04.3` · REQUIRED
- Prove operation-specific maker/builtin/binary-operation admitted domains/messages/order; retain unproved host-object/coercion paths by explicit routing before evaluation.
- Declared dependencies: `ports:A03.foundation`, `ports:A03.2`, `ports:A03.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No universal constructor erases distinct maker/builtin/binary-operation domains or messages.
- Defining-owner paths from the old plan: `packages/values/semantics/src/numeric/money.rs`, `packages/values/semantics/tests/money_vectors.rs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/money/basic.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Currency/basic money implementation and native tests exist, but malformed nonstring currency/interpolation/coercion domains are explicitly divergent/excluded from native corpus.
- Scoped evidence: [packages/values/semantics/src/numeric/money.rs](../../packages/values/semantics/src/numeric/money.rs), [packages/values/semantics/tests/money_vectors.rs](../../packages/values/semantics/tests/money_vectors.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A04.4 — Join money factors, one-round conversion and moneyRatio

- [ ] **Partly implemented / incomplete acceptance** · `ports:A04.4` · REQUIRED
- Complete full supported-domain one-round factor/ratio and failure-order ledger with exact shared decimal carrier policy; preserve any excluded paths explicitly.
- Declared dependencies: `ports:A04.3`, `ports:A04.2`, `ports:A03.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Complete money semantics match native vectors without duplicated decimal/rounding authority.
- Defining-owner paths from the old plan: `packages/values/semantics/src/numeric/money.rs`, `packages/values/semantics/tests/money_vectors.rs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/money/factors.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Money factor/one-round conversion/ratio native mechanisms match scoped vectors; full shared decimal-scale and excluded structural-failure domains lack final coverage.
- Scoped evidence: [packages/values/semantics/src/numeric/money.rs](../../packages/values/semantics/src/numeric/money.rs), [packages/values/semantics/tests/money_vectors.rs](../../packages/values/semantics/tests/money_vectors.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A04.5 — Expose pure numeric scalar codecs for validation reuse

- [ ] **Partly implemented / incomplete acceptance** · `ports:A04.5` · REQUIRED
- Complete numeric scalar codec error/path/text/stored-part proof including lossless UTF-16 or preselected retained TS domains before validation reuse is declared proved.
- Declared dependencies: `ports:A04.1`, `ports:A04.3`, `ports:C03.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Validation can reuse proven numeric codecs without awaiting unrelated money factor math or aggregate work.
- Defining-owner paths from the old plan: `packages/values/semantics/src/codecs/numeric.rs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/core/numeric-codecs.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Pure numeric scalar codecs are shared in values core; Rust String/error formatting cannot preserve all lone/split UTF-16 observations in current native transport.
- Scoped evidence: [packages/values/semantics/src/codecs/numeric.rs](../../packages/values/semantics/src/codecs/numeric.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A04 — Decimal, money and numeric codecs complete

- [ ] **Partly implemented / incomplete acceptance** · `ports:A04` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in exact-values.md; retain explicit supported/retained/deferred scope.
- All original A04 branches, full stored parts, one-round rules and independent oracle limits are covered.
- Declared dependencies: `ports:A04.1`, `ports:A04.2`, `ports:A04.3`, `ports:A04.4`, `ports:A04.5`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All original A04 branches, full stored parts, one-round rules and independent oracle limits are covered.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A05.3 — Port instant algorithms and temporal scalar codecs

- [ ] **Partly implemented / incomplete acceptance** · `ports:A05.3` · REQUIRED
- Close complete temporal export/error/text coverage and lossless codec diagnostics; retain divideDurationMs accounting under A04.2.
- Declared dependencies: `ports:A05.1`, `ports:A05.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Every temporal.ts exported pure algorithm is covered; decimal-valued divideDurationMs remains correctly covered in A04.2.
- Defining-owner paths from the old plan: `packages/values/semantics/src/temporal/instant.rs`, `packages/values/semantics/tests/temporal_vectors.rs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/temporal/instant.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Instant algorithms and temporal scalar codecs exist and pass ordinary native vectors; all exported pure operations plus malformed/lone UTF-16 codec diagnostics are not fully closed.
- Scoped evidence: [packages/values/semantics/src/temporal/instant.rs](../../packages/values/semantics/src/temporal/instant.rs), [packages/values/semantics/tests/temporal_vectors.rs](../../packages/values/semantics/tests/temporal_vectors.rs), [packages/values/semantics/src/codecs/numeric.rs](../../packages/values/semantics/src/codecs/numeric.rs), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/parity-ledger.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A05 — Temporal algorithms and scalar handoff complete

- [ ] **Partly implemented / incomplete acceptance** · `ports:A05` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in exact-values.md; retain explicit supported/retained/deferred scope.
- Native temporal vector runner matches all original A05 acceptance without an unnecessary A04 dependency.
- Declared dependencies: `ports:A05.1`, `ports:A05.2`, `ports:A05.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Native temporal vector runner matches all original A05 acceptance without an unnecessary A04 dependency.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A07.2 — Prepare host carriers, backend registry and bootstrap checks

- [ ] **Acceptance evidence missing** · `ports:A07.2` · REQUIRED
- Repair/qualify the malformed historical bootstrap evidence while preserving its exact pin/commands/results/scope; record narrow host carrier/bootstrap acceptance from existing source and scoped tests.
- Declared dependencies: `ports:A03.foundation`, `ports:C03.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Public classes/freezing/BigInt parts and synchronous exports stay intact; failed selected Rust bootstrap is visible.
- Defining-owner paths from the old plan: `packages/values/bindings/backend.ts`, `packages/values/bindings/bootstrap.ts`, `packages/values/bindings/carriers.ts`, `packages/values/test/exact-bootstrap.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/host/bootstrap.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Private synchronous carrier/backend/bootstrap scaffold and Node/Bun failure tests exist. Exact A07.2 narrow code behavior is credited, but historical evidence JSON is malformed and current scoped acceptance ledger needs qualification; full registry belongs A07.3, workerd aggregate proof A07.foundation.
- Scoped evidence: [packages/values/bindings/backend.ts](../../packages/values/bindings/backend.ts), [packages/values/bindings/bootstrap.ts](../../packages/values/bindings/bootstrap.ts), [packages/values/bindings/carriers.ts](../../packages/values/bindings/carriers.ts), [packages/values/test/exact-bootstrap.test.ts](../../packages/values/test/exact-bootstrap.test.ts), [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/host/bootstrap-20261006.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/host/bootstrap-20261006.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A07.foundation — Real binding and host bootstrap scaffold ready for validation

- [ ] **Partly implemented / incomplete acceptance** · `ports:A07.foundation` · REQUIRED
- Review actual tiny exact entry/host scaffold synchronous/bootstrap/carrier contract across Node/Bun/workerd without claiming full exact operation parity.
- Declared dependencies: `ports:A07.1`, `ports:A07.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Actual tiny glue/module imports and synchronous bootstrap/carrier contract are usable in Node/Bun/local workerd; validation can integrate independently of exact algorithm completion.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Real generated glue and structural workerd smoke exist, but aggregate exact bootstrap/carrier scaffold gate is not reviewed across Node/Bun/workerd at its required contract.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/core/binding-smoke-20261006.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/core/binding-smoke-20261006.json), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-binding-smoke.json](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-binding-smoke.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A07.3 — Join full semantic entries and actual-adapter differential

- [ ] **Partly implemented / incomplete acceptance** · `ports:A07.3` · REQUIRED
- Join full exact operation registry and lossless error/carrier transport; run complete vectors through native and actual Node/Bun/workerd delivered binding with version/asset failures.
- Declared dependencies: `ports:A03`, `ports:A04`, `ports:A05`, `ports:A06`, `ports:A07.foundation`, `ports:V03.5`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Full semantic vectors and asset/version/error checks pass through real binding and actual host delivery.
- Defining-owner paths from the old plan: `packages/values/semantics/src/lib.rs`, `packages/values/bindings/src/lib.rs`, `packages/values/bindings/src/exact.rs`, `packages/values/bindings/generated/`, `packages/values/semantics/examples/conformance.rs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/core/binding-parity.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Native full scalar runner and real binding entry exist, but host TS operation registry is explicitly limited smoke scaffolding; no full actual-adapter/Wasm differential/delivery proof.
- Scoped evidence: [packages/values/semantics/src/lib.rs](../../packages/values/semantics/src/lib.rs), [packages/values/bindings/src/lib.rs](../../packages/values/bindings/src/lib.rs), [packages/values/bindings/src/exact.rs](../../packages/values/bindings/src/exact.rs), [packages/values/bindings/generated/](../../packages/values/bindings/generated), [packages/values/semantics/examples/conformance.rs](../../packages/values/semantics/examples/conformance.rs), [packages/values/bindings/backend.ts](../../packages/values/bindings/backend.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A07 — Actual binding and full native/Wasm parity complete

- [ ] **Partly implemented / incomplete acceptance** · `ports:A07` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in exact-values.md; retain explicit supported/retained/deferred scope.
- Every original A07 bootstrap/build/carrier/delivery requirement is proved; no full-consumer adoption inferred.
- Declared dependencies: `ports:A07.foundation`, `ports:A07.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Every original A07 bootstrap/build/carrier/delivery requirement is proved; no full-consumer adoption inferred.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A08.1 — Route proven public profiles behind unchanged façades

- [ ] **Not implemented / no execution evidence** · `ports:A08.1` · REQUIRED
- Implement and prove: One selected backend per request; all unproved unknown profiles execute TS by declared pre-evaluation routing.
- Declared dependencies: `ports:A07`, `ports:V02.6`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: One selected backend per request; all unproved unknown profiles execute TS by declared pre-evaluation routing.
- Defining-owner paths from the old plan: `packages/values/src/int.ts`, `packages/values/src/decimal.ts`, `packages/values/src/money.ts`, `packages/values/src/kinds.ts`, `packages/values/src/temporal.ts`, `packages/values/src/array.ts`, `packages/values/src/equality.ts`, `packages/values/src/stdlib-pure.ts`, `packages/values/src/index.ts`, `packages/values/test/exact-backends.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/host/public-routing.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/values/src/int.ts](../../packages/values/src/int.ts), [packages/values/src/decimal.ts](../../packages/values/src/decimal.ts), [packages/values/src/money.ts](../../packages/values/src/money.ts), [packages/values/src/kinds.ts](../../packages/values/src/kinds.ts), [packages/values/src/temporal.ts](../../packages/values/src/temporal.ts), [packages/values/src/array.ts](../../packages/values/src/array.ts), [packages/values/src/equality.ts](../../packages/values/src/equality.ts), [packages/values/src/stdlib-pure.ts](../../packages/values/src/stdlib-pure.ts), [packages/values/src/index.ts](../../packages/values/src/index.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A08.2 — Verify synchronous package and stdlib consumer assembly

- [ ] **Not implemented / no execution evidence** · `ports:A08.2` · REQUIRED
- Implement and prove: All original A08 public/export/assembly checks pass, with baseline failures separately attributed.
- Declared dependencies: `ports:A08.1`, `ports:C04.values-assets`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All original A08 public/export/assembly checks pass, with baseline failures separately attributed.
- Defining-owner paths from the old plan: `packages/stdlib/test/exact-helper-chain.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/consumer/stdlib.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A08 — Selective public routing verified

- [ ] **Not implemented / no execution evidence** · `ports:A08` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in exact-values.md; retain explicit supported/retained/deferred scope.
- Synchronous exports, legacy traces and backend-entry instrumentation meet the original A08 contract.
- Declared dependencies: `ports:A08.1`, `ports:A08.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Synchronous exports, legacy traces and backend-entry instrumentation meet the original A08 contract.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A09.1 — Prepare joint owned HTTP/interface pilot fixtures

- [ ] **Not implemented / no execution evidence** · `ports:A09.1` · REQUIRED
- Implement and prove: Useful fixture preparation overlaps algorithms without claiming a whole-input port or production adoption.
- Declared dependencies: `ports:A01`, `ports:A02`, `ports:C02.ready`, `ports:C03.ready`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Useful fixture preparation overlaps algorithms without claiming a whole-input port or production adoption.
- Defining-owner paths from the old plan: `packages/interfaces/test/exact-input-profile.test.ts`, `packages/testkit/test/exact-operation-consumer.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/consumer/pilot-contract.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A09.2 — Run whole-input pilot through actual Wasm consumer

- [ ] **Not implemented / no execution evidence** · `ports:A09.2` · REQUIRED
- Implement and prove: Exact A09 join waits for completed V06–V08 evidence; forms and unproved transports retain TS with compatibility checks.
- Declared dependencies: `ports:A08`, `ports:A09.1`, `ports:V06`, `ports:V07`, `ports:V08`, `ports:C02.ready`, `ports:C03.ready`, `ports:C04.ready`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Exact A09 join waits for completed V06–V08 evidence; forms and unproved transports retain TS with compatibility checks.
- Defining-owner paths from the old plan: `packages/interfaces/test/exact-input-profile.test.ts`, `packages/testkit/test/exact-operation-consumer.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/consumer/http-parity.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A09 — Whole-input pilot and secondary helper-chain evidence complete

- [ ] **Partly implemented / incomplete acceptance** · `ports:A09` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in exact-values.md; retain explicit supported/retained/deferred scope.
- All original A09 complete-call and secondary .coef/.minor fixture obligations pass; no retained-handle claim or fixture-only deployed-use claim.
- Declared dependencies: `ports:A08`, `ports:A09.1`, `ports:A09.2`, `ports:V06`, `ports:V07`, `ports:V08`, `ports:C02.ready`, `ports:C03.ready`, `ports:C04.ready`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All original A09 complete-call and secondary .coef/.minor fixture obligations pass; no retained-handle claim or fixture-only deployed-use claim.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A10.1 — Measure complete-call performance and resources

- [ ] **Not implemented / no execution evidence** · `ports:A10.1` · REQUIRED
- Implement and prove: Zero unexplained differences; speed-led default meets fixed budgets or concrete native reuse justifies a compatible explicitly selected core without slower silent default.
- Declared dependencies: `ports:A09`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Zero unexplained differences; speed-led default meets fixed budgets or concrete native reuse justifies a compatible explicitly selected core without slower silent default.
- Defining-owner paths from the old plan: `packages/values/conformance/ports/exact/workloads.mjs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/measurements.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/adoption-report.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A10.2 — Verify packaged opt-in release and rollback

- [ ] **Not implemented / no execution evidence** · `ports:A10.2` · REQUIRED
- Implement and prove: No unsupported scalar switches; rollback restores TS without .can recompile or migration and never retries failed semantic work.
- Declared dependencies: `ports:A10.1`, `ports:A07`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No unsupported scalar switches; rollback restores TS without .can recompile or migration and never retries failed semantic work.
- Defining-owner paths from the old plan: `packages/values/test/exact-release.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/consumer/release-integrity.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/consumer/rollback.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A10.3 — Review deployment provenance and default-adoption decision

- [ ] **Not implemented / no execution evidence** · `ports:A10.3` · REQUIRED
- Implement and prove: The HTTP 501 gap is never closed by arithmetic fixture evidence; unsupported routes stay TS. If neither production route is proved, default adoption is blocked and the completed feasibility outcome records that fact.
- Declared dependencies: `ports:A10.2`, `ports:V08`, `ports:V10`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: The HTTP 501 gap is never closed by arithmetic fixture evidence; unsupported routes stay TS. If neither production route is proved, default adoption is blocked and the completed feasibility outcome records that fact.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/consumer/rollout-decision.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A10 — Measured release outcome and adoption gate recorded

- [ ] **Not implemented / no execution evidence** · `ports:A10` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in exact-values.md; retain explicit supported/retained/deferred scope.
- All original A10 performance/resource/release/rollback obligations are complete; enabled defaults require V08/V10 route-specific provenance, while a justified disabled result remains explicit.
- Declared dependencies: `ports:A10.1`, `ports:A10.2`, `ports:A10.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All original A10 performance/resource/release/rollback obligations are complete; enabled defaults require V08/V10 route-specific provenance, while a justified disabled result remains explicit.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A11.1 — Reconcile completion coverage and package documentation

- [ ] **Not implemented / no execution evidence** · `ports:A11.1` · REQUIRED
- Implement and prove: Every original A11 completion/documentation obligation is accounted for; bookkeeping authorizes no further implementation.
- Declared dependencies: `ports:A10`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Every original A11 completion/documentation obligation is accounted for; bookkeeping authorizes no further implementation.
- Defining-owner paths from the old plan: `packages/values/README.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/consumer/completion-ledger.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/consumer/final-source-checks.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/values/README.md](../../packages/values/README.md), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### A11 — Selected exact-values implementation outcome complete

- [ ] **Not implemented / no execution evidence** · `ports:A11` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in exact-values.md; retain explicit supported/retained/deferred scope.
- A01–A10 required evidence exists, real binding/consumer/release/rollback are proved and adoption enabled or explicitly blocked; retirement and broader legacy migration remain separate decisions.
- Declared dependencies: `ports:A11.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A01–A10 required evidence exists, real binding/consumer/release/rollback are proved and adoption enabled or explicitly blocked; retirement and broader legacy migration remain separate decisions.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/exact-values.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

## input-validation

## Required remaining — input-validation

### V01.1 — Freeze caller contracts and workload registry

- [ ] **Partly implemented / incomplete acceptance** · `ports:V01.1` · REQUIRED
- Refresh precise current source contracts and record required owning reviews; preserve replay/hash/auth/default/ref order and the single shared values core.
- Declared dependencies: `ports:C01.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Owners review each admitted domain, error/order/identity obligation and consumer; public arbitrary-unknown and hand-built schemas remain fully legacy TS. contracts.md and caller-inventory.json distinguish deployed MCP, HTTP 501, forms and handle mode; no full-port claim.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/contracts.md`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/caller-inventory.json`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/current-ts.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Detailed caller/state sequence/shared-core ownership contracts exist and content review passes; named owner approvals are required and unrecorded.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/input-validation/contracts.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/contracts.md), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/caller-inventory.json](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/caller-inventory.json), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/current-ts.json](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/current-ts.json), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/v01-review.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/v01-review.md), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-contract.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-contract.md), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/plan-contract.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/plan-contract.md), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V01.2 — Assess bounded HTTP adoption join

- [ ] **Partly implemented / incomplete acceptance** · `ports:V01.2` · REQUIRED
- Reconcile bounded owning-handler/source/delivery contract against current assembly/bundle seam; record owner-approved validation adoption or explicit blocked default outcome, distinct from generic TS HTTP feature proof.
- Declared dependencies: `ports:C01.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: C01 source-owner contract names exact existing-handler join and owning files, or states absence without inventing a new HTTP feature. Package/workerd fixture proof and default deployed adoption are separately testable gates; blocked join retains default 501.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-adoption-gate.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Historical bounded HTTP join contract exists but says AssemblyDeps.http seam absent; current assembly has generic HTTP operation seam and owning module builder, while Rust adoption remains unproved.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-adoption-gate.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-adoption-gate.md), [packages/cloudflare/src/worker/assembly.ts](../../packages/cloudflare/src/worker/assembly.ts), [packages/cloudflare/src/deploy/bundle.ts](../../packages/cloudflare/src/deploy/bundle.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V01.3 — Freeze state sequencing and bridge contract

- [ ] **Partly implemented / incomplete acceptance** · `ports:V01.3` · REQUIRED
- Refresh precise current source contracts and record required owning reviews; preserve replay/hash/auth/default/ref order and the single shared values core.
- Declared dependencies: `ports:C01.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Contract preserves readRevision → hash(raw) → readReceipt → replay OR age → membership/by → normalize/ref-extract → ordered loads and read auth-first. Protected graph never crosses arbitrary OperationInvoker callbacks; unproven/generated-handler/internal calls retain legacy TS.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-contract.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Detailed caller/state sequence/shared-core ownership contracts exist and content review passes; named owner approvals are required and unrecorded.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-contract.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-contract.md), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/v01-review.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/v01-review.md), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/contracts.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/contracts.md), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/plan-contract.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/plan-contract.md), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V01.4 — Agree owner-plan and shared-file handoffs

- [ ] **Partly implemented / incomplete acceptance** · `ports:V01.4` · REQUIRED
- Refresh precise current source contracts and record required owning reviews; preserve replay/hash/auth/default/ref order and the single shared values core.
- Declared dependencies: `ports:C01.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No second currency, Decimal, wire authority, catalog or compiler work; immutable data copies and private owner tokens establish provenance, never freeze/shape alone. Each lane has exclusive module files and exact-values publishes A03.foundation before arithmetic completion.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/plan-contract.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Detailed caller/state sequence/shared-core ownership contracts exist and content review passes; named owner approvals are required and unrecorded.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/input-validation/plan-contract.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/plan-contract.md), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/v01-review.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/v01-review.md), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/contracts.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/contracts.md), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-contract.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-contract.md), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V10.1 — Inspect installed MCP SDK producer seam early

- [ ] **Not implemented / no execution evidence** · `ports:V10.1` · REQUIRED
- Implement and prove: Decision includes source/version and evidence that a protected graph can stay inaccessible until conversion; types, freeze or SDK object inspection do not certify it.
- Implement and prove: Deferred MCP is explicitly unported and does not block HTTP preparation or deployment package proof.
- Declared dependencies: `ports:C01.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Decision includes source/version and evidence that a protected graph can stay inaccessible until conversion; types, freeze or SDK object inspection do not certify it. Deferred MCP is explicitly unported and does not block HTTP preparation or deployment package proof.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/mcp-provenance.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V10.2 — Assess forms producer separately

- [ ] **Not implemented / no execution evidence** · `ports:V10.2` · REQUIRED
- Implement and prove: No JSON lineage is inferred for form objects; coercion, duplicate and current __proto__ semantics are explicit.
- Implement and prove: Decision permits independent HTTP JSON progress and states that deferred forms are not ported.
- Declared dependencies: `ports:C01.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No JSON lineage is inferred for form objects; coercion, duplicate and current __proto__ semantics are explicit. Decision permits independent HTTP JSON progress and states that deferred forms are not ported.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/forms-provenance.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V02.6 — Wire private prepared hooks without public API drift

- [ ] **Not implemented / no execution evidence** · `ports:V02.6` · REQUIRED
- Install private genuine factory provenance and prepared validation/codec hooks without public export/signature/legacy evaluation drift; prove legacy unknown remains TS and no semantic retry.
- Declared dependencies: `ports:V02.1`, `ports:V02.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A1/B2 current/facade legacy traces match; unknown/default/schema accessors observe the old evaluation order. Private prepared calls reach extracted modules while unknown callers remain TS; no semantic exception retry.
- Defining-owner paths from the old plan: `packages/values/src/schema.ts`, `packages/values/src/wire.ts`, `packages/values/src/index.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-hook-review.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: normalizeSchema/wire/index have no private prepared provenance/hook join; handoff explicitly provides unapplied specification and tests mark provenance directly.
- Scoped evidence: [packages/values/src/schema.ts](../../packages/values/src/schema.ts), [packages/values/src/wire.ts](../../packages/values/src/wire.ts), [packages/values/src/index.ts](../../packages/values/src/index.ts), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-plan-handoff.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-plan-handoff.md), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V03.1 — Define validation ABI extension and decision vectors

- [ ] **Partly implemented / incomplete acceptance** · `ports:V03.1` · REQUIRED
- Record exact owning review of ABI decisions/vector corpus and reconcile implementation/profile contracts before aggregate ABI acceptance.
- Declared dependencies: `ports:V01`, `ports:C03.ready`, `ports:A03.foundation`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Vectors distinguish -0, huge rounded JSON integers, 1e400, numeric strings, null/bool/array/object, lone surrogate keys/text and own __proto__. Host JSON semantics preserved; number-free opaque json is never used as transport, fixed-width counts reject before coercion.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-vectors.json`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-decisions.md`, `packages/values/conformance/owned-input/v1/cases.json`, `packages/values/conformance/owned-input/v1/README.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Versioned ABI decision/vector corpus exists, including bits/UTF-16/presence/counts, but owner review requests explicitly remain open.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-vectors.json](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-vectors.json), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-decisions.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-decisions.md), [packages/values/conformance/owned-input/v1/cases.json](../../packages/values/conformance/owned-input/v1/cases.json), [packages/values/conformance/owned-input/v1/README.md](../../packages/values/conformance/owned-input/v1/README.md), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V03.3 — Create private parser token and controlled lineage

- [ ] **Partly implemented / incomplete acceptance** · `ports:V03.3` · REQUIRED
- Keep parser graph inaccessible until owned conversion, expose detached public copies and invalidate/loss-of-lineage after exposure/mutation as required.
- Prove actual unchanged capped HTTP reader/error/BOM/cancel/body-stage lineage against owning consumer; no arbitrary object adoption.
- Declared dependencies: `ports:V01`, `ports:C03.ready`, `ports:A03.foundation`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Forged tokens, frozen proxies, schema tags and mutated/exposed public copies cannot enter owned execution; no adopt(unknown). Malformed/empty/scalar-root JSON, byte caps/chunk cancellation, BOM and syntax errors match current host stage; forms retain their path.
- Defining-owner paths from the old plan: `packages/values/bindings/owned-input.ts`, `packages/interfaces/src/http/limits.ts`, `packages/values/test/owned-input.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Private parser-issued token and host-style decode/parse scaffold exist. Source returns the same mutable parser graph under a still-valid token; no complete protected-host confinement/detached-copy mutation acceptance proof exists. No production exposure is asserted.
- Scoped evidence: [packages/values/bindings/owned-input.ts](../../packages/values/bindings/owned-input.ts), [packages/interfaces/src/http/limits.ts](../../packages/interfaces/src/http/limits.ts), [packages/values/test/owned-input.test.ts](../../packages/values/test/owned-input.test.ts), [packages/values/bindings/owned-input.ts:94](../../packages/values/bindings/owned-input.ts), [packages/values/bindings/owned-input.ts:105](../../packages/values/bindings/owned-input.ts), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/v033-owned-input-20261006.json](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/v033-owned-input-20261006.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V03.4 — Implement owner registration and generation handles

- [ ] **Partly implemented / incomplete acceptance** · `ports:V03.4` · REQUIRED
- Review immutable provenance/handle/registration acceptance against actual binding and finalize matching generation/bound/default lifetime policy with V07 rather than treating scaffold registration as complete resource proof.
- Declared dependencies: `ports:V02.1`, `ports:V03.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Accessor/proxy schemas remain legacy; pre/post-registration mutation, schema identity reuse, forged defaults and duplicate/invalid descriptors cannot corrupt plans. Foreign/stale/disposed handles fail construction before execution, release is idempotent and no caller-controlled unbounded type-string cache.
- Defining-owner paths from the old plan: `packages/values/semantics/src/plans.rs`, `packages/values/bindings/plans.ts`, `packages/values/test/prepared-validation.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Owner registration/generation/stale/foreign/disposed handle scaffold/tests exist. Final policy remains open: N2 TS/Rust retirement bound accounting diverges; N3 preserves defaults intentionally through retirement, while full owner-release/disposal resource proof is unverified.
- Scoped evidence: [packages/values/semantics/src/plans.rs](../../packages/values/semantics/src/plans.rs), [packages/values/bindings/plans.ts](../../packages/values/bindings/plans.ts), [packages/values/test/prepared-validation.test.ts](../../packages/values/test/prepared-validation.test.ts), [packages/values/semantics/src/plans.rs:718](../../packages/values/semantics/src/plans.rs), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/v032-v034-20261006.json](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/v032-v034-20261006.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V02.7 — Publish complete current and prepared-TS comparator ledger

- [ ] **Partly implemented / incomplete acceptance** · `ports:V02.7` · REQUIRED
- Publish complete separately measured A1-A3/B2 current/prepared ledger including raw outcomes/identity/default/empty/sentinel/getter traces and costs; extraction alone is insufficient.
- Declared dependencies: `ports:V02.1`, `ports:V02.2`, `ports:V02.3`, `ports:V02.4`, `ports:V02.5`, `ports:V02.6`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Current/prepared baselines are separate auditable measured outcomes, not inferred from extraction or removed string parsing. A1–A3/B2 traces and default/empty/sentinel identity agree; prepared TS remains independently adoptable.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-ts.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Separate per-profile prepared semantic evidence exists, but full current/prepared measured complete-call comparator ledger and all legacy/default/sentinel traces are not assembled.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-values.json](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-values.json), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-http.json](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-http.json), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-mcp.json](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-mcp.json), [docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-state.json](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-state.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V04.1 — Implement ordered values traversal and policy

- [ ] **Not implemented / no execution evidence** · `ports:V04.1` · REQUIRED
- Implement and prove: B1 native fixed/seeded fixtures match all ordered errors, paths and values; failure never publishes partial result.
- Implement and prove: No JSON Schema/Serde default policy; create/update/nullability/nullable-array precedence and legacy presence remain unchanged.
- Declared dependencies: `ports:V02.2`, `ports:V03.2`, `ports:V03.4`, `ports:A04.5`, `ports:A05.3`, `ports:A04.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: B1 native fixed/seeded fixtures match all ordered errors, paths and values; failure never publishes partial result. No JSON Schema/Serde default policy; create/update/nullability/nullable-array precedence and legacy presence remain unchanged.
- Defining-owner paths from the old plan: `packages/values/semantics/src/validation.rs`, `packages/values/semantics/src/profiles/values.rs`, `packages/values/semantics/tests/input_validation/values.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V04.2 — Implement owned codec dispatch and materialization

- [ ] **Not implemented / no execution evidence** · `ports:V04.2` · REQUIRED
- Implement and prove: Exact spelling/leading zeros/-0/scale/canonical text, numeric JSON refusal, money currency/keys and temporal edges match shared oracle.
- Implement and prove: Repeated defaults/empty arrays keep identity and frozen structure; returned structural BigInt/Decimal/Money match TS, generated-state arrays stay fresh.
- Declared dependencies: `ports:V04.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Exact spelling/leading zeros/-0/scale/canonical text, numeric JSON refusal, money currency/keys and temporal edges match shared oracle. Repeated defaults/empty arrays keep identity and frozen structure; returned structural BigInt/Decimal/Money match TS, generated-state arrays stay fresh.
- Defining-owner paths from the old plan: `packages/values/semantics/src/codecs/owned.rs`, `packages/values/bindings/materialize.ts`, `packages/values/semantics/tests/input_validation/values.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06.1 — Implement HTTP-only native profile

- [ ] **Not implemented / no execution evidence** · `ports:V06.1` · REQUIRED
- Implement and prove: No values interpreter or URL/Intl predicate prerequisite; HTTP first unknown → first missing → first bound order and path spelling match.
- Implement and prove: HTTP ref extras/currency-string and deferred string/boolean semantics remain permissive as baseline; top-level/action_handle rules unchanged.
- Declared dependencies: `ports:V02.3`, `ports:V03.2`, `ports:V03.4`, `ports:A04.5`, `ports:A05.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No values interpreter or URL/Intl predicate prerequisite; HTTP first unknown → first missing → first bound order and path spelling match. HTTP ref extras/currency-string and deferred string/boolean semantics remain permissive as baseline; top-level/action_handle rules unchanged.
- Defining-owner paths from the old plan: `packages/values/semantics/src/profiles/http.rs`, `packages/values/semantics/tests/input_validation/http.rs`, `packages/interfaces/test/owned-http.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/interfaces/test/owned-http.test.ts](../../packages/interfaces/test/owned-http.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06.2 — Implement generated-state native profile

- [ ] **Not implemented / no execution evidence** · `ports:V06.2` · REQUIRED
- Implement and prove: Native vectors preserve safe-number conversion, extra ref-member permissiveness, unescaped legacy paths and state-specific error accumulation.
- Implement and prove: No external store/auth/ref loads are performed by pure profile; model/defaulted scenario callable remains host-owned.
- Declared dependencies: `ports:V02.4`, `ports:V03.2`, `ports:V03.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Native vectors preserve safe-number conversion, extra ref-member permissiveness, unescaped legacy paths and state-specific error accumulation. No external store/auth/ref loads are performed by pure profile; model/defaulted scenario callable remains host-owned.
- Defining-owner paths from the old plan: `packages/values/semantics/src/profiles/state.rs`, `packages/values/semantics/tests/input_validation/state.rs`, `packages/state/test/invocation/owned-admission.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/state/test/invocation/owned-admission.test.ts](../../packages/state/test/invocation/owned-admission.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06.3 — Implement ordinary MCP native policy

- [ ] **Not implemented / no execution evidence** · `ports:V06.3` · REQUIRED
- Implement and prove: Native pure fixtures agree with current/prepared including multi-error disagreement cases; sealed mode untouched.
- Implement and prove: Implementation of profile alone never certifies SDK producer seam or claims deployed migration.
- Declared dependencies: `ports:V02.5`, `ports:V03.2`, `ports:V03.4`, `ports:A04.5`, `ports:A05.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Native pure fixtures agree with current/prepared including multi-error disagreement cases; sealed mode untouched. Implementation of profile alone never certifies SDK producer seam or claims deployed migration.
- Defining-owner paths from the old plan: `packages/values/semantics/src/profiles/mcp.rs`, `packages/values/semantics/tests/input_validation/mcp.rs`, `packages/interfaces/test/owned-mcp.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/interfaces/test/owned-mcp.test.ts](../../packages/interfaces/test/owned-mcp.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06.8 — Register HTTP action after exact binding handoff

- [ ] **Not implemented / no execution evidence** · `ports:V06.8` · REQUIRED
- Implement and prove: Actual HTTP whole-profile binding compiles and runs without waiting for values/predicates/SDK/forms; no duplicate numeric transport or shared-file race.
- Declared dependencies: `ports:V06.1`, `ports:V03.5`, `ports:A07`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Actual HTTP whole-profile binding compiles and runs without waiting for values/predicates/SDK/forms; no duplicate numeric transport or shared-file race.
- Defining-owner paths from the old plan: `packages/values/semantics/src/lib.rs`, `packages/values/semantics/src/profiles.rs`, `packages/values/bindings/src/lib.rs`, `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/semantics/tests/input_validation.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/values/semantics/src/lib.rs](../../packages/values/semantics/src/lib.rs), [packages/values/semantics/src/profiles.rs](../../packages/values/semantics/src/profiles.rs), [packages/values/bindings/src/lib.rs](../../packages/values/bindings/src/lib.rs), [packages/values/bindings/src/validation.rs](../../packages/values/bindings/src/validation.rs), [packages/values/bindings/validation.ts](../../packages/values/bindings/validation.ts), [packages/values/semantics/tests/input_validation.rs](../../packages/values/semantics/tests/input_validation.rs), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06.9 — Register generated-state action in serial integration queue

- [ ] **Not implemented / no execution evidence** · `ports:V06.9` · REQUIRED
- Implement and prove: State actual binding compiles against presence/ref policy without full values traversal; integrator alone edits shared roots.
- Declared dependencies: `ports:V06.2`, `ports:V06.8`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: State actual binding compiles against presence/ref policy without full values traversal; integrator alone edits shared roots.
- Defining-owner paths from the old plan: `packages/values/semantics/src/lib.rs`, `packages/values/semantics/src/profiles.rs`, `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/semantics/tests/input_validation.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/values/semantics/src/lib.rs](../../packages/values/semantics/src/lib.rs), [packages/values/semantics/src/profiles.rs](../../packages/values/semantics/src/profiles.rs), [packages/values/bindings/src/validation.rs](../../packages/values/bindings/src/validation.rs), [packages/values/bindings/validation.ts](../../packages/values/bindings/validation.ts), [packages/values/semantics/tests/input_validation.rs](../../packages/values/semantics/tests/input_validation.rs), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06.10 — Register ordinary MCP action in serial integration queue

- [ ] **Not implemented / no execution evidence** · `ports:V06.10` · REQUIRED
- Implement and prove: Pure MCP actual binding compiles and owns separate profile policy; no implication of verified SDK lineage.
- Declared dependencies: `ports:V06.3`, `ports:V06.9`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Pure MCP actual binding compiles and owns separate profile policy; no implication of verified SDK lineage.
- Defining-owner paths from the old plan: `packages/values/semantics/src/lib.rs`, `packages/values/semantics/src/profiles.rs`, `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/semantics/tests/input_validation.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/values/semantics/src/lib.rs](../../packages/values/semantics/src/lib.rs), [packages/values/semantics/src/profiles.rs](../../packages/values/semantics/src/profiles.rs), [packages/values/bindings/src/validation.rs](../../packages/values/bindings/src/validation.rs), [packages/values/bindings/validation.ts](../../packages/values/bindings/validation.ts), [packages/values/semantics/tests/input_validation.rs](../../packages/values/semantics/tests/input_validation.rs), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V04.4 — Register values interpreter and materialization in serial queue

- [ ] **Not implemented / no execution evidence** · `ports:V04.4` · REQUIRED
- Implement and prove: Actual whole values calls reconstruct structural/default/sentinel results and ordered failures; shared module edits remain serialized.
- Declared dependencies: `ports:V04.2`, `ports:V06.10`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Actual whole values calls reconstruct structural/default/sentinel results and ordered failures; shared module edits remain serialized.
- Defining-owner paths from the old plan: `packages/values/semantics/src/lib.rs`, `packages/values/semantics/src/profiles.rs`, `packages/values/semantics/src/codecs/mod.rs`, `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/semantics/tests/input_validation.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/values/semantics/src/lib.rs](../../packages/values/semantics/src/lib.rs), [packages/values/semantics/src/profiles.rs](../../packages/values/semantics/src/profiles.rs), [packages/values/semantics/src/codecs/mod.rs](../../packages/values/semantics/src/codecs/mod.rs), [packages/values/bindings/src/validation.rs](../../packages/values/bindings/src/validation.rs), [packages/values/bindings/validation.ts](../../packages/values/bindings/validation.ts), [packages/values/semantics/tests/input_validation.rs](../../packages/values/semantics/tests/input_validation.rs), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V05.1 — Prove demand-ordered host predicate protocol

- [ ] **Not implemented / no execution evidence** · `ports:V05.1` · REQUIRED
- Implement and prove: No lossy String conversion or eager precomputation before earlier violations; runtime URL/locale/timezone/currency behavior matches.
- Implement and prove: Unsupported plan fallback precedes input evaluation, never retries semantic exceptions; HTTP can progress without these callbacks.
- Declared dependencies: `ports:V04.2`, `ports:V04.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No lossy String conversion or eager precomputation before earlier violations; runtime URL/locale/timezone/currency behavior matches. Unsupported plan fallback precedes input evaluation, never retries semantic exceptions; HTTP can progress without these callbacks.
- Defining-owner paths from the old plan: `packages/values/bindings/predicates.ts`, `packages/values/semantics/src/codecs/owned.rs`, `packages/values/semantics/tests/input_validation/values.rs`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/host-predicates.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V05.2 — Encode retained interpreter results inside request

- [ ] **Not implemented / no execution evidence** · `ports:V05.2` · REQUIRED
- Implement and prove: Same-call normalize+encode parity preserves scale/canonical text, shape/error paths and structural/default identity.
- Implement and prove: Request-scoped result cannot be forged, reused after disposal or adopted from arbitrary unknown.
- Declared dependencies: `ports:V05.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Same-call normalize+encode parity preserves scale/canonical text, shape/error paths and structural/default identity. Request-scoped result cannot be forged, reused after disposal or adopted from arbitrary unknown.
- Defining-owner paths from the old plan: `packages/values/semantics/src/codecs/owned.rs`, `packages/values/bindings/materialize.ts`, `packages/values/semantics/tests/input_validation/values.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V05.3 — Wire proved predicate and retained-encode glue

- [ ] **Not implemented / no execution evidence** · `ports:V05.3` · REQUIRED
- Implement and prove: Host invocation order, unsupported-plan selection and lossless text/error formatting agree through actual binding; same-session results never escape disposal.
- Declared dependencies: `ports:V05.2`, `ports:V04.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Host invocation order, unsupported-plan selection and lossless text/error formatting agree through actual binding; same-session results never escape disposal.
- Defining-owner paths from the old plan: `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/test/validation-binding.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/values/bindings/src/validation.rs](../../packages/values/bindings/src/validation.rs), [packages/values/bindings/validation.ts](../../packages/values/bindings/validation.ts), [packages/values/test/validation-binding.test.ts](../../packages/values/test/validation-binding.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V04.3 — Run actual-binding values parity and identity

- [ ] **Not implemented / no execution evidence** · `ports:V04.3` · REQUIRED
- Implement and prove: B1/B2/A1 have zero unexplained differences for supported values profile; no partial output on failure.
- Implement and prove: Tagged UTF-16/f64 fixtures do not collapse -0/nonfinite/identity and retained legacy traces prove Rust is not invoked.
- Declared dependencies: `ports:V04.2`, `ports:V04.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: B1/B2/A1 have zero unexplained differences for supported values profile; no partial output on failure. Tagged UTF-16/f64 fixtures do not collapse -0/nonfinite/identity and retained legacy traces prove Rust is not invoked.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/values-differential.json`, `packages/values/conformance/owned-input/v1/cases.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/values/conformance/owned-input/v1/cases.json](../../packages/values/conformance/owned-input/v1/cases.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06.4 — Run independent HTTP actual-binding profile parity

- [ ] **Not implemented / no execution evidence** · `ports:V06.4` · REQUIRED
- Implement and prove: A2/B2 errors and raw business inputs agree including optional-property absence and baseline pointer spelling.
- Implement and prove: Binding does not allocate/validate before host auth/CSRF/ID stages when installed at consumer.
- Declared dependencies: `ports:V06.1`, `ports:V06.8`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A2/B2 errors and raw business inputs agree including optional-property absence and baseline pointer spelling. Binding does not allocate/validate before host auth/CSRF/ID stages when installed at consumer.
- Defining-owner paths from the old plan: `packages/interfaces/test/owned-http.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-profile-differential.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/interfaces/test/owned-http.test.ts](../../packages/interfaces/test/owned-http.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06.5 — Run state actual-binding profile parity

- [ ] **Not implemented / no execution evidence** · `ports:V06.5` · REQUIRED
- Implement and prove: A3/B2 pure state matches current aggregate paths/errors and ordered refs without store side effects.
- Implement and prove: Generated defaults/scalars/interim identity remain in owning scope.
- Declared dependencies: `ports:V06.2`, `ports:V06.9`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A3/B2 pure state matches current aggregate paths/errors and ordered refs without store side effects. Generated defaults/scalars/interim identity remain in owning scope.
- Defining-owner paths from the old plan: `packages/state/test/invocation/owned-admission.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-profile-differential.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/state/test/invocation/owned-admission.test.ts](../../packages/state/test/invocation/owned-admission.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06.6 — Run MCP actual-binding profile parity

- [ ] **Not implemented / no execution evidence** · `ports:V06.6` · REQUIRED
- Implement and prove: A2/B2 preserve exact refs, ID UTF-16 limits, InvalidParams and sealed-path selection.
- Implement and prove: Passing vectors do not mark MCP production port complete when SDK branch is deferred.
- Declared dependencies: `ports:V06.3`, `ports:V06.10`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A2/B2 preserve exact refs, ID UTF-16 limits, InvalidParams and sealed-path selection. Passing vectors do not mark MCP production port complete when SDK branch is deferred.
- Defining-owner paths from the old plan: `packages/interfaces/test/owned-mcp.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/mcp-profile-differential.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/interfaces/test/owned-mcp.test.ts](../../packages/interfaces/test/owned-mcp.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V07.1 — Finalize request/plan limits and cleanup implementation

- [ ] **Partly implemented / incomplete acceptance** · `ports:V07.1` · REQUIRED
- Finalize and prove the exact same prepared/Rust owner limits/registration/retirement/default cleanup contract before serving; retain legacy domains and pre-replay sequencing.
- Stale/foreign/generation handles reject before Rust; traps/stack overflow are adapter failures, not legacy cycle RangeError.
- No active eviction, global result retention or unchecked counts; public legacy domain unchanged.
- Declared dependencies: `ports:V03.2`, `ports:V03.3`, `ports:V03.4`, `ports:V03.5`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Stale/foreign/generation handles reject before Rust; traps/stack overflow are adapter failures, not legacy cycle RangeError. No active eviction, global result retention or unchecked counts; public legacy domain unchanged.
- Defining-owner paths from the old plan: `packages/values/semantics/src/input.rs`, `packages/values/bindings/owned-input.ts`, `packages/values/test/validation-lifecycle.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/resource-policy.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Stale/foreign/generation handle checks, provisional owner bound and release scaffolds exist. Final unified serving budgets, cleanup/default lifetime and TS/Rust N2 accounting policy have not been finalized/proved.
- Scoped evidence: [packages/values/semantics/src/input.rs](../../packages/values/semantics/src/input.rs), [packages/values/bindings/owned-input.ts](../../packages/values/bindings/owned-input.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V07.5 — Apply finalized owner-plan budget and release policy

- [ ] **Partly implemented / incomplete acceptance** · `ports:V07.5` · REQUIRED
- Finalize and prove the exact same prepared/Rust owner limits/registration/retirement/default cleanup contract before serving; retain legacy domains and pre-replay sequencing.
- Registration over budget rejects owner before serving; no active plan eviction, stale handle execution or retained defaults after owner disposal.
- Same prepared/Rust owner contract applies without caching arbitrary schemas or narrowing legacy exports.
- Declared dependencies: `ports:V07.1`, `ports:V03.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Registration over budget rejects owner before serving; no active plan eviction, stale handle execution or retained defaults after owner disposal. Same prepared/Rust owner contract applies without caching arbitrary schemas or narrowing legacy exports.
- Defining-owner paths from the old plan: `packages/values/semantics/src/plans.rs`, `packages/values/bindings/plans.ts`, `packages/values/src/prepared/plan.ts`, `packages/values/test/prepared-validation.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Stale/foreign/generation handle checks, provisional owner bound and release scaffolds exist. Final unified serving budgets, cleanup/default lifetime and TS/Rust N2 accounting policy have not been finalized/proved.
- Scoped evidence: [packages/values/semantics/src/plans.rs](../../packages/values/semantics/src/plans.rs), [packages/values/bindings/plans.ts](../../packages/values/bindings/plans.ts), [packages/values/src/prepared/plan.ts](../../packages/values/src/prepared/plan.ts), [packages/values/test/prepared-validation.test.ts](../../packages/values/test/prepared-validation.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V07.2 — Prove HTTP resource readiness independently

- [ ] **Not implemented / no execution evidence** · `ports:V07.2` · REQUIRED
- Implement and prove: Owned prepared TS and Rust enforce same fixed policy; memory plateaus and no result/default survives its owner scope.
- Implement and prove: HTTP rollout is unblocked by completed HTTP resource evidence, without waiting for optional MCP/forms or values predicates.
- Declared dependencies: `ports:V07.1`, `ports:V07.5`, `ports:V06.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Owned prepared TS and Rust enforce same fixed policy; memory plateaus and no result/default survives its owner scope. HTTP rollout is unblocked by completed HTTP resource evidence, without waiting for optional MCP/forms or values predicates.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-resources.json`, `packages/values/conformance/owned-input/v1/resources.mjs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V07.3 — Apply owned budgets to prepared values comparator

- [ ] **Not implemented / no execution evidence** · `ports:V07.3` · REQUIRED
- Implement and prove: Selected backend does not change owned limits; unsupported legacy plans keep old success/exception domain.
- Implement and prove: Earlier semantic failures retain precedence over later predicates/allocation work.
- Declared dependencies: `ports:V07.1`, `ports:V05.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Selected backend does not change owned limits; unsupported legacy plans keep old success/exception domain. Earlier semantic failures retain precedence over later predicates/allocation work.
- Defining-owner paths from the old plan: `packages/values/src/prepared/validation.ts`, `packages/values/src/prepared/codec.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/values/src/prepared/validation.ts](../../packages/values/src/prepared/validation.ts), [packages/values/src/prepared/codec.ts](../../packages/values/src/prepared/codec.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V07.4 — Complete cross-profile resource proof

- [ ] **Not implemented / no execution evidence** · `ports:V07.4` · REQUIRED
- Implement and prove: B3 measured memory plateaus under representative and adversarial workloads; defined limits have no Rust traps and no stale cross-request reuse.
- Implement and prove: No defaults survive owner release or results request disposal; state successful replay incurs no new-plan budget before replay.
- Declared dependencies: `ports:V07.2`, `ports:V07.3`, `ports:V06.5`, `ports:V06.6`, `ports:V05.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: B3 measured memory plateaus under representative and adversarial workloads; defined limits have no Rust traps and no stale cross-request reuse. No defaults survive owner release or results request disposal; state successful replay incurs no new-plan budget before replay.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/resources.json`, `packages/values/conformance/owned-input/v1/resources.mjs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V09.1 — Implement canonical private provenance bridge handoff

- [ ] **Not implemented / no execution evidence** · `ports:V09.1` · REQUIRED
- Implement and prove: HTTP lane consumes bridge API without editing runtime/invoke.ts; state lane alone owns bridge modules.
- Implement and prove: Public copy mutation loses token use; unknown/custom callbacks retain legacy validation; copy cost is separately observable.
- Declared dependencies: `ports:V01.3`, `ports:V03.3`, `ports:V02.4`, `ports:W06.runtimehandoff`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: HTTP lane consumes bridge API without editing runtime/invoke.ts; state lane alone owns bridge modules. Public copy mutation loses token use; unknown/custom callbacks retain legacy validation; copy cost is separately observable.
- Defining-owner paths from the old plan: `packages/cloudflare/src/runtime/invoke.ts`, `packages/state/src/invocation/prepared-inputs.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/bridge-handoff.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/cloudflare/src/runtime/invoke.ts](../../packages/cloudflare/src/runtime/invoke.ts), [packages/state/src/invocation/prepared-inputs.ts](../../packages/state/src/invocation/prepared-inputs.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V08.1 — Install whole HTTP action at existing validation point

- [ ] **Not implemented / no execution evidence** · `ports:V08.1` · REQUIRED
- Implement and prove: A2/B4 order/status/body, body-cap/malformed JSON, top-level/action_handle, missing/unknown/bounds and HTML redisplay match.
- Implement and prove: No Rust work before current validation point; one selected backend per request and no semantic-error retry.
- Declared dependencies: `ports:V06.4`, `ports:V07.2`, `ports:V03.3`, `ports:V09.1`, `ports:C04.ready`, `ports:A07`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A2/B4 order/status/body, body-cap/malformed JSON, top-level/action_handle, missing/unknown/bounds and HTML redisplay match. No Rust work before current validation point; one selected backend per request and no semantic-error retry.
- Defining-owner paths from the old plan: `packages/interfaces/src/http/operations.ts`, `packages/interfaces/test/owned-http.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/interfaces/src/http/operations.ts](../../packages/interfaces/src/http/operations.ts), [packages/interfaces/test/owned-http.test.ts](../../packages/interfaces/test/owned-http.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V08.2 — Prove actual handler package consumer in workerd

- [ ] **Not implemented / no execution evidence** · `ports:V08.2` · REQUIRED
- Implement and prove: B4/A2 real workerd request reaches existing owning handler and canonical state invocation; mock or fixture-only JS binding is insufficient.
- Implement and prove: Report package consumer proof separately from default deployed traffic; unit injected invoker does not certify deployment.
- Declared dependencies: `ports:V08.1`, `ports:V09.1`, `ports:C04.values-assets`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: B4/A2 real workerd request reaches existing owning handler and canonical state invocation; mock or fixture-only JS binding is insufficient. Report package consumer proof separately from default deployed traffic; unit injected invoker does not certify deployment.
- Defining-owner paths from the old plan: `packages/cloudflare/test/owned-http-route.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-consumer.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V08.3 — Decide bounded default deployment adoption

- [ ] **Not implemented / no execution evidence** · `ports:V08.3` · REQUIRED
- Implement and prove: Decision cannot create a new HTTP feature or treat fixture-only workerd as real default production use.
- Implement and prove: Default join acceptance explicitly dispatches V08.4/V08.5; absence leaves package completion possible with deployed adoption blocked.
- Declared dependencies: `ports:V01.2`, `ports:V08.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Decision cannot create a new HTTP feature or treat fixture-only workerd as real default production use. Default join acceptance explicitly dispatches V08.4/V08.5; absence leaves package completion possible with deployed adoption blocked.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-adoption-gate.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-adoption-gate.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-adoption-gate.md), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V08.6 — Close HTTP package and deployment ledger separately

- [ ] **Not implemented / no execution evidence** · `ports:V08.6` · REQUIRED
- Implement and prove: Package gate is complete only with actual handler/binding/workerd proof.
- Implement and prove: Default deployment is enabled only on accepted implemented join or explicitly blocked; optional branch boxes remain open when deferred.
- Declared dependencies: `ports:V08.2`, `ports:V08.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Package gate is complete only with actual handler/binding/workerd proof. Default deployment is enabled only on accepted implemented join or explicitly blocked; optional branch boxes remain open when deferred.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-completion.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V09.2 — Install owned state execution after replay/auth only

- [ ] **Not implemented / no execution evidence** · `ports:V09.2` · REQUIRED
- Implement and prove: Matching receipt replays even when input is now expired/forbidden/malformed or current plan/budget fails; conflicting raw reuse fails before normalizing.
- Implement and prove: Array fills/defaults never change persisted hash; admission/load/stale/archive/conflict-current/fence/read order unchanged.
- Declared dependencies: `ports:V06.5`, `ports:V07.2`, `ports:V09.1`, `ports:A07`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Matching receipt replays even when input is now expired/forbidden/malformed or current plan/budget fails; conflicting raw reuse fails before normalizing. Array fills/defaults never change persisted hash; admission/load/stale/archive/conflict-current/fence/read order unchanged.
- Defining-owner paths from the old plan: `packages/state/src/invocation/admission.ts`, `packages/state/src/invocation/invoke.ts`, `packages/state/src/invocation/prepared-inputs.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/state/src/invocation/admission.ts](../../packages/state/src/invocation/admission.ts), [packages/state/src/invocation/invoke.ts](../../packages/state/src/invocation/invoke.ts), [packages/state/src/invocation/prepared-inputs.ts](../../packages/state/src/invocation/prepared-inputs.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V09.3 — Prove durable state consumer traces and copy cost

- [ ] **Not implemented / no execution evidence** · `ports:V09.3` · REQUIRED
- Implement and prove: Exact mutation trace and read auth-first match baseline; no eager ref loads on earlier failure, toJSON legacy ordering unchanged.
- Implement and prove: Raw digest/receipt compatibility and replay survive backend change; copies included in economic evidence.
- Declared dependencies: `ports:V09.2`, `ports:V08.2`, `ports:V07.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Exact mutation trace and read auth-first match baseline; no eager ref loads on earlier failure, toJSON legacy ordering unchanged. Raw digest/receipt compatibility and replay survive backend change; copies included in economic evidence.
- Defining-owner paths from the old plan: `packages/state/test/invocation/owned-admission.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-replay-traces.json`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-copy-cost.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/state/test/invocation/owned-admission.test.ts](../../packages/state/test/invocation/owned-admission.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V10.3 — Decide MCP adoption from complete seam and profile proof

- [ ] **Not implemented / no execution evidence** · `ports:V10.3` · REQUIRED
- Implement and prove: Only parser-created internal lineage before exposure, without second parse or object adoption, enables branch.
- Implement and prove: HTTP package/default gate remains independent; deferred result cannot be labelled full MCP port.
- Declared dependencies: `ports:V10.1`, `ports:V06.6`, `ports:V07.4`, `ports:C04.ready`, `ports:A07`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Only parser-created internal lineage before exposure, without second parse or object adoption, enables branch. HTTP package/default gate remains independent; deferred result cannot be labelled full MCP port.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/mcp-provenance.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V10.7 — Close optional adoption decisions without false completion

- [ ] **Not implemented / no execution evidence** · `ports:V10.7` · REQUIRED
- Implement and prove: MCP/forms deferred/legacy status never marks their full port done; required scope-review gate may close while optional work remains open.
- Implement and prove: HTTP progress/measurement only consumes decision ledger, not deferred implementation.
- Declared dependencies: `ports:V10.3`, `ports:V10.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: MCP/forms deferred/legacy status never marks their full port done; required scope-review gate may close while optional work remains open. HTTP progress/measurement only consumes decision ledger, not deferred implementation.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/optional-coverage.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06.7 — Assemble profile differential ledger

- [ ] **Not implemented / no execution evidence** · `ports:V06.7` · REQUIRED
- Implement and prove: All owned rows agree across current/prepared/native/actual binding; native-only JSON not credited.
- Implement and prove: Separate HTTP first errors, state aggregates, values accumulations and MCP stages remain visible.
- Declared dependencies: `ports:V06.4`, `ports:V06.5`, `ports:V06.6`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All owned rows agree across current/prepared/native/actual binding; native-only JSON not credited. Separate HTTP first errors, state aggregates, values accumulations and MCP stages remain visible.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/profile-differential.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V11.1 — Precommit workloads and numeric adoption budgets

- [ ] **Not implemented / no execution evidence** · `ports:V11.1` · REQUIRED
- Implement and prove: Precommitment precedes final comparisons and contains representative malformed/error-heavy HTTP/state/replay workloads plus supported MCP only.
- Implement and prove: Worker CPU timing follows shared harness policy; leaf/native timings or removed type parsing cannot justify adoption.
- Declared dependencies: `ports:V01`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Precommitment precedes final comparisons and contains representative malformed/error-heavy HTTP/state/replay workloads plus supported MCP only. Worker CPU timing follows shared harness policy; leaf/native timings or removed type parsing cannot justify adoption.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/measurement-contract.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V11.2 — Prepare private release selection and rollback join

- [ ] **Not implemented / no execution evidence** · `ports:V11.2` · REQUIRED
- Implement and prove: Missing/corrupt/version/ABI/init failures in selected Rust fail startup; ordinary package API remains synchronous/importable.
- Implement and prove: No receipt/raw-hash/default/schema migration and no duplicate auth/store/provider execution or shadowing legacy getters.
- Declared dependencies: `ports:V02`, `ports:V07`, `ports:V08`, `ports:V09`, `ports:V10`, `ports:C04.ready`, `ports:C04.values-assets`, `ports:A07`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Missing/corrupt/version/ABI/init failures in selected Rust fail startup; ordinary package API remains synchronous/importable. No receipt/raw-hash/default/schema migration and no duplicate auth/store/provider execution or shadowing legacy getters.
- Defining-owner paths from the old plan: `packages/values/bindings/backend.ts`, `packages/values/bindings/bootstrap.ts`, `packages/values/bindings/validation.ts`, `packages/values/tsconfig.json`, `packages/values/package.json`, `packages/values/Cargo.toml`, `packages/values/Cargo.lock`, `packages/values/semantics/Cargo.toml`, `packages/values/bindings/Cargo.toml`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/selection-rollback.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/values/bindings/backend.ts](../../packages/values/bindings/backend.ts), [packages/values/bindings/bootstrap.ts](../../packages/values/bindings/bootstrap.ts), [packages/values/bindings/validation.ts](../../packages/values/bindings/validation.ts), [packages/values/tsconfig.json](../../packages/values/tsconfig.json), [packages/values/package.json](../../packages/values/package.json), [packages/values/Cargo.toml](../../packages/values/Cargo.toml), [packages/values/Cargo.lock](../../packages/values/Cargo.lock), [packages/values/semantics/Cargo.toml](../../packages/values/semantics/Cargo.toml), [packages/values/bindings/Cargo.toml](../../packages/values/bindings/Cargo.toml), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V11.3 — Measure complete selected calls and retained resources

- [ ] **Not implemented / no execution evidence** · `ports:V11.3` · REQUIRED
- Implement and prove: Zero unexplained parity differences and complete-call budgets assessed at precommitted thresholds; core-entry counts show real routing.
- Implement and prove: Results distinguish package fixture, default deployment and deferred consumers; no Rust-only interpreter or parser-removal inference.
- Declared dependencies: `ports:V11.1`, `ports:V11.2`, `ports:V05`, `ports:V06`, `ports:V07`, `ports:V08`, `ports:V09`, `ports:V10`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Zero unexplained parity differences and complete-call budgets assessed at precommitted thresholds; core-entry counts show real routing. Results distinguish package fixture, default deployment and deferred consumers; no Rust-only interpreter or parser-removal inference.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/measurements.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V11.4 — Review Rust versus prepared-TS adoption decision

- [ ] **Not implemented / no execution evidence** · `ports:V11.4` · REQUIRED
- Implement and prove: No benefit retains prepared TS and experiment evidence; supported selected Rust requires C04, HTTP package/resource/parity and rollback proof.
- Implement and prove: State normalization stays after replay/auth even if HTTP enabled; deferred production paths never claimed migrated.
- Declared dependencies: `ports:V11.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No benefit retains prepared TS and experiment evidence; supported selected Rust requires C04, HTTP package/resource/parity and rollback proof. State normalization stays after replay/auth even if HTTP enabled; deferred production paths never claimed migrated.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/rollout-decision.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V12.1 — Audit changed source, exports and release inventory

- [ ] **Not implemented / no execution evidence** · `ports:V12.1` · REQUIRED
- Implement and prove: No unexplained new diagnostic, public handle/export drift or hidden retained TS; complete source/output/lifetime ledger is reviewable.
- Implement and prove: Rollback/release bytes and raw receipt digest/schema remain unchanged; missing gate reported explicitly.
- Declared dependencies: `ports:V11`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No unexplained new diagnostic, public handle/export drift or hidden retained TS; complete source/output/lifetime ledger is reviewable. Rollback/release bytes and raw receipt digest/schema remain unchanged; missing gate reported explicitly.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/final-source-checks.md`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/verify.log`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V12.2 — Reconcile living filetree after actual merges

- [ ] **Partly implemented / incomplete acceptance** · `ports:V12.2` · REQUIRED
- At actual final port completion reconcile all reviewed merged owner/source/retained/unsupported coverage and decisions; advance checkpoint only after complete review.
- Declared dependencies: `ports:V12.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Merged implementation coverage/checkpoint reflects complete reviewed changes; this planning conversion itself does not advance it. Final source list distinguishes implemented, proposed, unsupported and retained TS with ownership.
- Defining-owner paths from the old plan: `docs/ideal-filetree-plan.md`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/filetree-review.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Post-consolidation structural filetree bookkeeping exists at fdb059c; full port final implementation/cutover review and checkpoint remain explicitly open.
- Scoped evidence: [docs/ideal-filetree-plan.md](../../docs/ideal-filetree-plan.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V12.3 — Review declared-port completion and gaps

- [ ] **Not implemented / no execution evidence** · `ports:V12.3` · REQUIRED
- Implement and prove: Declared owned port is complete only with supported real binding and actual handler workerd proof plus rollback/resources/source review.
- Implement and prove: Blocked adoption or deferred optional branches stay labelled; never claim complete legacy validator/MCP/forms migration.
- Declared dependencies: `ports:V12.1`, `ports:V12.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Declared owned port is complete only with supported real binding and actual handler workerd proof plus rollback/resources/source review. Blocked adoption or deferred optional branches stay labelled; never claim complete legacy validator/MCP/forms migration.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/rollout-decision.md`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/completion-ledger.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V01 — Caller and ownership contracts reviewed

- [ ] **Partly implemented / incomplete acceptance** · `ports:V01` · REQUIRED
- Record owner approvals and current caller/gap/workload contract review; do not infer gate closure from prepared code existing.
- Declared dependencies: `ports:V01.1`, `ports:V01.2`, `ports:V01.3`, `ports:V01.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Five profile/input domains, workloads, baseline and HTTP/source ownership gap agreed.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Content review is CONDITIONAL PASS with owning reviews explicitly pending, and historical HTTP seam premises have drifted.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/input-validation/v01-review.md](../../docs/research/package-subsystem-ports-20261006/evidence/input-validation/v01-review.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V02 — Prepared TS complete-call baseline reviewed

- [ ] **Partly implemented / incomplete acceptance** · `ports:V02` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- A1–A3/B2 current/prepared semantics, identity, order, timings and retained legacy traces agree.
- Declared dependencies: `ports:V02.1`, `ports:V02.2`, `ports:V02.3`, `ports:V02.4`, `ports:V02.5`, `ports:V02.6`, `ports:V02.7`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A1–A3/B2 current/prepared semantics, identity, order, timings and retained legacy traces agree.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V03 — Versioned ownership ABI proved through actual binding

- [ ] **Partly implemented / incomplete acceptance** · `ports:V03` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- Same-call scalar/UTF-16/provenance/handle vectors pass native, Node/Bun and C04 workerd; references/version/limit decisions recorded.
- Declared dependencies: `ports:V03.1`, `ports:V03.2`, `ports:V03.3`, `ports:V03.4`, `ports:V03.5`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Same-call scalar/UTF-16/provenance/handle vectors pass native, Node/Bun and C04 workerd; references/version/limit decisions recorded.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V04 — Values ordered interpreter and identity proved

- [ ] **Not implemented / no execution evidence** · `ports:V04` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- Complete values semantics match shared A04/A05 exact codecs through native and binding; identity/no partial results proved.
- Declared dependencies: `ports:V04.1`, `ports:V04.2`, `ports:V04.3`, `ports:V04.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Complete values semantics match shared A04/A05 exact codecs through native and binding; identity/no partial results proved.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V05 — Host predicate and optional encode contract proved

- [ ] **Not implemented / no execution evidence** · `ports:V05` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- Demand-ordered host text/predicates/errors and same-session encoding match; unsupported plans selected TS before execution.
- Declared dependencies: `ports:V05.1`, `ports:V05.2`, `ports:V05.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Demand-ordered host text/predicates/errors and same-session encoding match; unsupported plans selected TS before execution.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V06 — Independent policy profiles reviewed

- [ ] **Not implemented / no execution evidence** · `ports:V06` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- HTTP/MCP/state pure profile parity includes intentional version/ref/error/presence disagreements; no invented values schemas.
- Declared dependencies: `ports:V06.1`, `ports:V06.2`, `ports:V06.3`, `ports:V06.4`, `ports:V06.5`, `ports:V06.6`, `ports:V06.7`, `ports:V06.8`, `ports:V06.9`, `ports:V06.10`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: HTTP/MCP/state pure profile parity includes intentional version/ref/error/presence disagreements; no invented values schemas.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V07 — All owned resource/lifetime gates reviewed

- [ ] **Not implemented / no execution evidence** · `ports:V07` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- B3 same prepared/Rust versioned budget and cleanup plateau evidence reviewed; no legacy narrowing or pre-replay Rust work.
- Declared dependencies: `ports:V07.1`, `ports:V07.2`, `ports:V07.3`, `ports:V07.4`, `ports:V07.5`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: B3 same prepared/Rust versioned budget and cleanup plateau evidence reviewed; no legacy narrowing or pre-replay Rust work.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V08 — Actual HTTP package consumer and adoption ledger reviewed

- [ ] **Not implemented / no execution evidence** · `ports:V08` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- B4 actual handler/canonical invocation/Wasm/workerd proved; accepted join requires V08.4/V08.5 or default 501 remains explicitly blocked.
- Declared dependencies: `ports:V08.1`, `ports:V08.2`, `ports:V08.3`, `ports:V08.6`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: B4 actual handler/canonical invocation/Wasm/workerd proved; accepted join requires V08.4/V08.5 or default 501 remains explicitly blocked.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V09 — Canonical owned-state sequencing and durable proof reviewed

- [ ] **Not implemented / no execution evidence** · `ports:V09` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- A3/A4/B4 raw hash/receipt replay/auth/ref loads/fences/reads and protected copy cost match; unproven paths retained TS.
- Declared dependencies: `ports:V09.1`, `ports:V09.2`, `ports:V09.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A3/A4/B4 raw hash/receipt replay/auth/ref loads/fences/reads and protected copy cost match; unproven paths retained TS.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V10 — Optional MCP/forms outcome ledger reviewed

- [ ] **Not implemented / no execution evidence** · `ports:V10` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- Decision review only: accepted MCP/forms require conditional consumer task proofs; deferred optional task boxes stay open and their full ports are not complete.
- Declared dependencies: `ports:V10.1`, `ports:V10.2`, `ports:V10.3`, `ports:V10.7`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Decision review only: accepted MCP/forms require conditional consumer task proofs; deferred optional task boxes stay open and their full ports are not complete.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V11 — Measured backend/adoption and rollback decision reviewed

- [ ] **Not implemented / no execution evidence** · `ports:V11` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- B5 actual complete-call evidence and precommitted budgets/native reuse justify selected outcome; unsupported/default deployment scope explicit.
- Declared dependencies: `ports:V11.1`, `ports:V11.2`, `ports:V11.3`, `ports:V11.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: B5 actual complete-call evidence and precommitted budgets/native reuse justify selected outcome; unsupported/default deployment scope explicit.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V12 — Final declared owned-port completion review

- [ ] **Partly implemented / incomplete acceptance** · `ports:V12` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in input-validation.md; retain explicit supported/retained/deferred scope.
- Final-source-checks, verify.log, rollout decision and merged filetree review complete; definition of done satisfied or adoption blocked explicitly.
- Declared dependencies: `ports:V12.1`, `ports:V12.2`, `ports:V12.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Final-source-checks, verify.log, rollout decision and merged filetree review complete; definition of done satisfied or adoption blocked explicitly.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

## Conditional or deferred — input-validation

### V08.4 — Land owning assembly join when accepted

- [ ] **Partly implemented / incomplete acceptance** · `ports:V08.4` · ACCEPTED-CONDITIONAL
- Only if V08.3 accepts bounded Rust join, install owned validation handler/canonical bridge at this existing assembly seam and prove host stages/sealed/other routes with actual binary.
- Declared dependencies: `ports:V08.3`, `ports:V09.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Owning default route serves existing handler rather than interim 501; no new server/feature scope. A4/B4 assembly and workerd trace preserves host stages and sealed/other routes.
- Defining-owner paths from the old plan: `packages/cloudflare/src/worker/assembly.ts`, `packages/cloudflare/test/owned-http-route.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: Generic AssemblyDeps.http operation-handler seam and deploy HTTP module builder are already implemented for TS flows; accepted owned Rust validation join itself is absent.
- Scoped evidence: [packages/cloudflare/src/worker/assembly.ts](../../packages/cloudflare/src/worker/assembly.ts), [packages/cloudflare/src/worker/assembly.ts:554](../../packages/cloudflare/src/worker/assembly.ts), [packages/cloudflare/src/deploy/bundle.ts:693](../../packages/cloudflare/src/deploy/bundle.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V08.5 — Verify shared delivery module join when accepted

- [ ] **Not implemented / no execution evidence** · `ports:V08.5` · ACCEPTED-CONDITIONAL
- Implement and prove: A4/B4 owning joined entry/map serves actual handler using shipped binary, not fixture-only module inventory.
- Implement and prove: Missing/corrupt/wrong-version binaries fail visibly; release inventory/source maps never decode Wasm as text.
- Declared dependencies: `ports:V08.4`, `ports:C04.validation-join`, `ports:A07`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A4/B4 owning joined entry/map serves actual handler using shipped binary, not fixture-only module inventory. Missing/corrupt/wrong-version binaries fail visibly; release inventory/source maps never decode Wasm as text.
- Defining-owner paths from the old plan: `packages/cloudflare/test/owned-input-delivery.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-default-deployment.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V10.4 — Implement SDK-owned ordinary path only when accepted

- [ ] **Not implemented / no execution evidence** · `ports:V10.4` · ACCEPTED-CONDITIONAL
- Implement and prove: A2/B4 SDK JSON-RPC framing/error/results and InvalidParams agree; sealed mode keeps current orchestration.
- Implement and prove: Actual consumer proof, not profile fixtures alone, is required before MCP adoption enabled.
- Declared dependencies: `ports:V10.3`, `ports:V08.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: A2/B4 SDK JSON-RPC framing/error/results and InvalidParams agree; sealed mode keeps current orchestration. Actual consumer proof, not profile fixtures alone, is required before MCP adoption enabled.
- Defining-owner paths from the old plan: `packages/interfaces/src/mcp/server.ts`, `packages/interfaces/src/mcp/schemas.ts`, `packages/interfaces/test/owned-mcp.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/mcp-consumer.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/interfaces/src/mcp/server.ts](../../packages/interfaces/src/mcp/server.ts), [packages/interfaces/src/mcp/schemas.ts](../../packages/interfaces/src/mcp/schemas.ts), [packages/interfaces/test/owned-mcp.test.ts](../../packages/interfaces/test/owned-mcp.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V10.5 — Implement faithful form producer only when accepted

- [ ] **Not implemented / no execution evidence** · `ports:V10.5` · ACCEPTED-CONDITIONAL
- Implement and prove: Forms current/prepared/binding semantics and error/form draft match; no silent __proto__ fix or arbitrary-object adoption.
- Implement and prove: Unproved producer remains TS and branch incomplete.
- Declared dependencies: `ports:V10.2`, `ports:V07.2`, `ports:V08.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Forms current/prepared/binding semantics and error/form draft match; no silent __proto__ fix or arbitrary-object adoption. Unproved producer remains TS and branch incomplete.
- Defining-owner paths from the old plan: `packages/interfaces/src/http/forms-owned.ts`, `packages/interfaces/test/owned-forms.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/forms-consumer.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### V10.6 — Hook accepted form producer through HTTP owner

- [ ] **Not implemented / no execution evidence** · `ports:V10.6` · ACCEPTED-CONDITIONAL
- Implement and prove: Optional forms acceptance proves complete consumer and faithful protected lineage; HTTP JSON semantics preserved.
- Declared dependencies: `ports:V10.5`, `ports:V08.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Optional forms acceptance proves complete consumer and faithful protected lineage; HTTP JSON semantics preserved.
- Defining-owner paths from the old plan: `packages/interfaces/src/http/operations.ts`, `packages/interfaces/test/owned-http.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/interfaces/src/http/operations.ts](../../packages/interfaces/src/http/operations.ts), [packages/interfaces/test/owned-http.test.ts](../../packages/interfaces/test/owned-http.test.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/input-validation.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

## shared

## Required remaining — shared

### C04.ready — Tiny actual loader and typed asset proof ready

- [ ] **Acceptance evidence missing** · `ports:C04.ready` · REQUIRED
- Record scoped aggregate readiness against the accepted C04.asset/C04.1/C04.2 evidence; preserve final package/installed gates.
- Declared dependencies: `ports:C04.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Runtime plans may verify their own generated bindings next. This gate does not certify actual values/work assets, final vendor maps or installed consumers. Native JS-only preparation is independent of this Wasm proof.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C04.ready.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Both tiny loader and typed asset inputs have accepted evidence, but no C04.ready gate record exists. This is readiness only.
- Scoped evidence: [docs/ideal-filetree-plan/integration-20261006-c042.json](../../docs/ideal-filetree-plan/integration-20261006-c042.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### C04.graph — Land root and consumer dependency/build graph

- [ ] **Partly implemented / incomplete acceptance** · `ports:C04.graph` · REQUIRED
- Complete exact state/Cloudflare/stdlib/testkit dependency/build/lock graph requested by actual consumer adapters; prove installed resolution and absence of state-to-full-work cycle.
- Declared dependencies: `ports:W02.foundation`, `ports:C04.asset`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Root/consumer build and lockfile graph is executable, no state→full-work cycle, and no compiler Cargo workspace is introduced. This gate does not certify final work assets.
- Defining-owner paths from the old plan: `package.json`, `bun.lock`, `packages/cloudflare/package.json`, `packages/state/package.json`, `packages/stdlib/package.json`, `packages/testkit/package.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Root workspace/lockfile/build order register work-kernel and full combined build passes, but consumer manifests do not yet declare a work-kernel dependency; semantic imports are unjoined.
- Scoped evidence: [package.json](../../package.json), [bun.lock](../../bun.lock), [packages/cloudflare/package.json](../../packages/cloudflare/package.json), [packages/state/package.json](../../packages/state/package.json), [packages/stdlib/package.json](../../packages/stdlib/package.json), [packages/testkit/package.json](../../packages/testkit/package.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### C04.values-assets — Fulfil actual values binding and vendor inventory

- [ ] **Partly implemented / incomplete acceptance** · `ports:C04.values-assets` · REQUIRED
- Fulfil actual values glue/Wasm vendor/import and release stamp/manifest inventory for the selected consumer.
- Verify missing/corrupt/version failures in actual shipped assets and exclude native binaries from Worker maps.
- Declared dependencies: `ports:A07.foundation`, `ports:C04.graph`, `ports:C04.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Values consumers use actual shipped assets, not the smoke fixture; native binary is excluded from Worker maps; missing/corrupt/version errors fail visibly.
- Defining-owner paths from the old plan: `packages/cloudflare/src/deploy/bundle.ts`, `packages/cloudflare/src/release/stamp.ts`, `packages/cloudflare/src/release/manifest.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Real generated values glue/Wasm are staged into local values dist with complete name/length/SHA checks; no final actual values Worker vendor/import/release inventory and installed consumer proof.
- Scoped evidence: [packages/cloudflare/src/deploy/bundle.ts](../../packages/cloudflare/src/deploy/bundle.ts), [packages/cloudflare/src/release/stamp.ts](../../packages/cloudflare/src/release/stamp.ts), [packages/cloudflare/src/release/manifest.ts](../../packages/cloudflare/src/release/manifest.ts), [packages/values/scripts/stage-semantics.mjs](../../packages/values/scripts/stage-semantics.mjs), [packages/values/bindings/generated/BUILD.json](../../packages/values/bindings/generated/BUILD.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### C04.work-assets — Fulfil work generated asset and package request

- [ ] **Not implemented / no execution evidence** · `ports:C04.work-assets` · REQUIRED
- Fulfil W05.2 exact package-specific generated binary/glue/vendor/import and release inventory after actual W05.1 assembly.
- Declared dependencies: `ports:W05.2`, `ports:C04.graph`, `ports:C04.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Actual work binary and package are in built runtime/deploy/testkit inventory; W05.4/W05.3 certify installed package and workerd afterward.
- Defining-owner paths from the old plan: `packages/cloudflare/src/deploy/bundle.ts`, `packages/cloudflare/src/dev/local-run.ts`, `packages/testkit/src/scopes/local.ts`, `packages/cloudflare/src/release/stamp.ts`, `packages/cloudflare/src/release/manifest.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Work-kernel Cargo currently builds a VERSION-only skeleton and no generated work binding/loader/assets exist.
- Scoped evidence: [packages/cloudflare/src/deploy/bundle.ts](../../packages/cloudflare/src/deploy/bundle.ts), [packages/cloudflare/src/dev/local-run.ts](../../packages/cloudflare/src/dev/local-run.ts), [packages/testkit/src/scopes/local.ts](../../packages/testkit/src/scopes/local.ts), [packages/cloudflare/src/release/stamp.ts](../../packages/cloudflare/src/release/stamp.ts), [packages/cloudflare/src/release/manifest.ts](../../packages/cloudflare/src/release/manifest.ts), [packages/work-kernel/Cargo.toml](../../packages/work-kernel/Cargo.toml), [packages/work-kernel/rust/lib.rs](../../packages/work-kernel/rust/lib.rs), [packages/work-kernel/src/index.ts](../../packages/work-kernel/src/index.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### C04.native-release — Land native command, stamp and dist inventory

- [ ] **Human-held** · `ports:C04.native-release` · REQUIRED
- On explicit human resume, fulfil reviewed native command/prebuilt executable/license/dist stamp and manifest request; preserve JS-only releases and Worker exclusion.
- Declared dependencies: `ports:P09.1`, `ports:C04.graph`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Native supported-host binaries/notices/dist metadata ship through owning manifest; P09.2 must prove actual installed launch, no user compiler.
- Defining-owner paths from the old plan: `packages/cloudflare/package.json`, `packages/cloudflare/src/release/stamp.ts`, `packages/cloudflare/src/release/manifest.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Native release request is submitted; package command/stamp/dist integration and supported installed executable proof remain open under human HOLD.
- Scoped evidence: [packages/cloudflare/package.json](../../packages/cloudflare/package.json), [packages/cloudflare/src/release/stamp.ts](../../packages/cloudflare/src/release/stamp.ts), [packages/cloudflare/src/release/manifest.ts](../../packages/cloudflare/src/release/manifest.ts), [docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/native-release-request.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/native-release-request.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### C04.validation-join — Fulfil accepted validation route or record declined join

- [ ] **Not implemented / no execution evidence** · `ports:C04.validation-join` · REQUIRED
- Record bounded validation join acceptance/decline after V08.3; if accepted fulfil actual owning module map and binary integration following V08.4, leaving V08.5 delivery proof separate.
- Declared dependencies: `ports:V08.3`, `ports:C04.values-assets`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Accepted delivery integration completes after V08.4 and its own module checks; subsequent V08.5 proves deployment, required by V08.6 before accepted outcome completion. A declined branch changes no route and never certifies deployed adoption.
- Defining-owner paths from the old plan: `packages/cloudflare/src/deploy/bundle.ts`, `packages/cloudflare/src/dev/local-run.ts`, `packages/testkit/src/scopes/local.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Generic HTTP operation seam/module builder exists, but no accepted validation-specific assembly/delivery outcome record or declined-join closure.
- Scoped evidence: [packages/cloudflare/src/deploy/bundle.ts](../../packages/cloudflare/src/deploy/bundle.ts), [packages/cloudflare/src/dev/local-run.ts](../../packages/cloudflare/src/dev/local-run.ts), [packages/testkit/src/scopes/local.ts](../../packages/testkit/src/scopes/local.ts), [packages/cloudflare/src/worker/assembly.ts](../../packages/cloudflare/src/worker/assembly.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### C01.complete — All caller inventories and scope records reviewed

- [ ] **Partly implemented / incomplete acceptance** · `ports:C01.complete` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in shared.md; retain explicit supported/retained/deferred scope.
- Every migrated path has an owner, admitted-input contract, real consumer and explicit retained/deferred scope.
- Declared dependencies: `ports:C01.ready`, `ports:A01`, `ports:V01`, `ports:W01`, `ports:P01`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Every migrated path has an owner, admitted-input contract, real consumer and explicit retained/deferred scope.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C01.complete.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### C02.complete — All matching prepared TS boundaries reviewed

- [ ] **Partly implemented / incomplete acceptance** · `ports:C02.complete` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in shared.md; retain explicit supported/retained/deferred scope.
- Zero unexplained prepared/current TS observable differences; extraction never collapses differing policies.
- Declared dependencies: `ports:C02.ready`, `ports:A02`, `ports:V02`, `ports:W02`, `ports:P02`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Zero unexplained prepared/current TS observable differences; extraction never collapses differing policies.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C02.complete.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### C03.complete — All actual binding and protocol contracts reviewed

- [ ] **Partly implemented / incomplete acceptance** · `ports:C03.complete` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in shared.md; retain explicit supported/retained/deferred scope.
- Version, presence, lifetime, corruption and binding/native negative evidence is complete for each selected profile.
- Declared dependencies: `ports:C03.ready`, `ports:A07`, `ports:V03`, `ports:W03`, `ports:P03`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Version, presence, lifetime, corruption and binding/native negative evidence is complete for each selected profile.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C03.complete.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### C04.complete — All declared distribution and consumer assets reviewed

- [ ] **Partly implemented / incomplete acceptance** · `ports:C04.complete` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in shared.md; retain explicit supported/retained/deferred scope.
- Generated package-specific glue, actual consumers and supported installed hosts pass; declined validation route retains its visible adoption gap.
- Declared dependencies: `ports:C04.ready`, `ports:C04.graph`, `ports:C04.values-assets`, `ports:C04.work-assets`, `ports:C04.preparation-join`, `ports:C04.native-release`, `ports:C04.validation-join`, `ports:A08`, `ports:V11`, `ports:W05`, `ports:P09`, `ports:P05.mixed`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Generated package-specific glue, actual consumers and supported installed hosts pass; declined validation route retains its visible adoption gap.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C04.complete.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### C05.complete — All parity, budget and rollout evidence reviewed

- [ ] **Partly implemented / incomplete acceptance** · `ports:C05.complete` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in shared.md; retain explicit supported/retained/deferred scope.
- No unexplained observable differences; actual complete-call/native-reuse adoption and resource decisions retain raw evidence.
- Declared dependencies: `ports:C05.ready`, `ports:A10`, `ports:V11`, `ports:W07`, `ports:P10`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: No unexplained observable differences; actual complete-call/native-reuse adoption and resource decisions retain raw evidence.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C05.complete.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/shared.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/README.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/README.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

## work-transitions

## Required remaining — work-transitions

### W01.3 — Capture unchanged behavior, clone and persisted-byte baseline

- [ ] **Partly implemented / incomplete acceptance** · `ports:W01.3` · REQUIRED
- Retain frozen source/test/probe evidence and exact original failures; add actual durable stored-byte baseline under real D1/DO rather than treating recording fakes as live proof.
- Declared dependencies: `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Run existing command block against inspected sources, retain logs and failures; failed noEmitOnError builds cannot supply stale dist evidence. Save original row/result identity, state clone-only versus work safety-then-clone, error/trace ordering and actual D1/DO persisted bytes in immutable evidence as an independent oracle; pure owner lanes copy/hash their golden fixture subsets later.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/current-ts.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/verify.log`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/original-fixtures/`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Immutable current-TS/clone/identity/persisted-byte baseline is preserved; actual D1/DO adapter methods used recording fakes, not real durable handles.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/current-ts.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/current-ts.json), [docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/verify.log](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/verify.log), [docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/original-fixtures/](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/original-fixtures), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W01.4 — Ratify workload, budget and supported-profile ledger

- [ ] **Partly implemented / incomplete acceptance** · `ports:W01.4` · REQUIRED
- Freeze ratified numeric complete-call/resource/asset budgets or reviewed disabled-prototype scope and document historical ordering/uncertainty before final comparison/adoption.
- Declared dependencies: `ports:W01.1`, `ports:W01.2`, `ports:W01.3`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Nominate tiny/page/501-member/error/restart/recovery workloads and numeric latency/memory/binary budgets before seeing Rust comparisons. Identify retained unknown-object/callback/host hashing/recurrence hash paths and new operation resource limits without silently narrowing legacy inputs.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/workloads.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/budgets.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/coverage.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Workload/coverage/budget dimensions exist, but numeric latency/memory/binary budgets explicitly remain UNRATIFIED/TBD; standalone native comparisons already exist.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/workloads.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/workloads.json), [docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/budgets.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/budgets.json), [docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/coverage.md](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/coverage.md), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W02.5 — Compose package TS façade and legacy row wrappers

- [ ] **Not implemented / no execution evidence** · `ports:W02.5` · REQUIRED
- Assemble TS facade/profiles/backend entry and exact work/state wrappers, preserving classes/messages/cloning/pending/synchronous shapes; prove installed exports and leaf/consumer conformance.
- Declared dependencies: `ports:W02.2`, `ports:W02.3`, `ports:W02.4`, `ports:C04.graph`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Single integrator assembles entries and profiles; preserve work/state/runtime classes/messages, pending pin policy, row clone/metadata and same exported synchronous shapes. Build/typecheck leaf and consumers; installed exports resolve without full work/state/test-loader/Node-crypto runtime imports. Run proposed conformance glob and baseline suites.
- Defining-owner paths from the old plan: `packages/work-kernel/src/index.ts`, `packages/work-kernel/src/prepared.ts`, `packages/work-kernel/src/profiles.ts`, `packages/work-kernel/src/backend.ts`, `packages/work-kernel/conformance/transitions.test.ts`, `packages/work/src/kernel/tables.ts`, `packages/state/src/fanout/tables.ts`, `packages/state/src/fanout/outcome.ts`, `packages/state/src/receipt/tables.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Public package entry exports VERSION/facts only; prepared/profile/backend façade and work/state legacy row wrappers are not joined to decision leaf.
- Scoped evidence: [packages/work-kernel/src/index.ts](../../packages/work-kernel/src/index.ts), [packages/work/src/kernel/tables.ts](../../packages/work/src/kernel/tables.ts), [packages/state/src/fanout/tables.ts](../../packages/state/src/fanout/tables.ts), [packages/state/src/fanout/outcome.ts](../../packages/state/src/fanout/outcome.ts), [packages/state/src/receipt/tables.ts](../../packages/state/src/receipt/tables.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W03.1 — Freeze ordered facts and policy-specific ABI types

- [ ] **Acceptance evidence missing** · `ports:W03.1` · REQUIRED
- Review and pin the exact implemented ABI declarations/helpers against W03.1 acceptance, with source-specific vectors for foreign producer provenance, wrong transport, known-but-wrong profile, malformed/corrupt facts and fixed-width ranges.
- Record an actual fact-consumer entry that invokes those checks before any semantic callback, including zero-callback negative traces; implement any missing guards required by the accepted contract.
- Keep opaque payload refs distinct from authority capabilities; full controlled D1/DO producer provenance and host trace adoption remain W03.4/W06.
- Declared dependencies: `ports:W01.1`, `ports:W01.2`, `ports:W02.1`, `ports:C03.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Define version/profile/error/UTF-16/presence/f64/conditional version transport and producer provenance, validating number ranges before fixed-width conversion. Reject foreign/version/profile/corrupt facts before semantic callbacks; opaque payload refs are not authority capabilities.
- Defining-owner paths from the old plan: `packages/work-kernel/src/facts.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/abi.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Policy-specific types/constants/ABI handoff and standalone version/count/reference helper implementations exist. No isolated conformance test or real fact-consuming callback boundary was found: validateVersions/validateCount have no production call sites, foreign-fact/profile-mismatch occur as rejection vocabulary only, and type provenance is structural. Exact rejection-before-callback acceptance remains unproved.
- Scoped evidence: [packages/work-kernel/src/facts.ts](../../packages/work-kernel/src/facts.ts), [docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/abi.md](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/abi.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W03.2 — Implement call-local opaque reference lifecycle

- [ ] **Partly implemented / incomplete acceptance** · `ports:W03.2` · REQUIRED
- Execute/pin the existing refs.json expected traces through the actual bindings/host-values.ts implementation after implementation work is resumed; no such runner proof is claimed here.
- Prove actual profile-point retain-versus-structuredClone identity, stale/cross-call/disposed references, success/exception/cancel/rejected-load cleanup, allocation configuration/bound refusal and original clone-failure propagation.
- Join the host carrier at a reviewed real consumer rather than treating fixture expectations or typechecking as observed lifecycle behavior.
- Declared dependencies: `ports:W03.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Retain result identity or required structuredClone at the existing profile point; Rust cannot inspect untouched payloads/metadata. Dispose on success, exception, cancel and rejected load; reject stale/cross-call indices, bound allocation and preserve clone failures.
- Defining-owner paths from the old plan: `packages/work-kernel/bindings/host-values.ts`, `packages/work-kernel/conformance/fixtures/traces/refs.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: bindings/host-values.ts implements call-local references, cloning and finally disposal/cancellation helpers; refs.json is a frozen expected-trace fixture. No host-values conformance test or production use of CallScope/runInScope was found. Lifecycle/order/clone-failure execution acceptance and profile-point consumer join remain unproved.
- Scoped evidence: [packages/work-kernel/bindings/host-values.ts](../../packages/work-kernel/bindings/host-values.ts), [packages/work-kernel/conformance/fixtures/traces/refs.json](../../packages/work-kernel/conformance/fixtures/traces/refs.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W03.3 — Extract demand-ordered legacy host shells and trace tests

- [ ] **Not implemented / no execution evidence** · `ports:W03.3` · REQUIRED
- Extract and prove exact demand-ordered host shells through the prepared kernel; certify actual D1/DO controlled facts, errors/identity/cloning/stop-on-error and retained arbitrary callback/getter paths.
- Declared dependencies: `ports:W02.5`, `ports:W03.1`, `ports:W03.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Keep commit/inherited/supersession/pending/guard/authority/mint/clock orders distinct by shell; exhaustion/validation demand zero RNG samples, eligible backoff exactly one. Recovery validates/processes rows in order and demands uncertain-only evidence before later rows, stopping at original exception; retain TS callback paths where extraction is uneconomical. Full/selected grant/content/fence traces differ; preserve getter/proxy reads, sparse arrays, aliases/cycles and original thrown values, including throwing never-throws predicates.
- Defining-owner paths from the old plan: `packages/work/src/dispatch/index.ts`, `packages/work/src/receipt/index.ts`, `packages/work/src/recovery/index.ts`, `packages/work/src/observation/association.ts`, `packages/work/src/observation/observation.ts`, `packages/work/src/observation/ports.ts`, `packages/work/src/schedule/every.ts`, `packages/work/src/kernel/commands.ts`, `packages/work-kernel/conformance/traces.test.ts`, `packages/work-kernel/conformance/fixtures/traces/`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Original host shells and unrelated accepted TS workflows remain, but prepared kernel demand extraction/closed producer provenance and full legacy-vs-prepared trace proof are absent.
- Scoped evidence: [packages/work/src/dispatch/index.ts](../../packages/work/src/dispatch/index.ts), [packages/work/src/receipt/index.ts](../../packages/work/src/receipt/index.ts), [packages/work/src/recovery/index.ts](../../packages/work/src/recovery/index.ts), [packages/work/src/observation/association.ts](../../packages/work/src/observation/association.ts), [packages/work/src/observation/observation.ts](../../packages/work/src/observation/observation.ts), [packages/work/src/observation/ports.ts](../../packages/work/src/observation/ports.ts), [packages/work/src/schedule/every.ts](../../packages/work/src/schedule/every.ts), [packages/work/src/kernel/commands.ts](../../packages/work/src/kernel/commands.ts), [packages/work-kernel/conformance/fixtures/traces/](../../packages/work-kernel/conformance/fixtures/traces), [packages/cloudflare/src/runtime/invoke.ts](../../packages/cloudflare/src/runtime/invoke.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W03.4 — Verify closed-fact provenance and prepared-vs-legacy traces

- [ ] **Not implemented / no execution evidence** · `ports:W03.4` · REQUIRED
- Extract and prove exact demand-ordered host shells through the prepared kernel; certify actual D1/DO controlled facts, errors/identity/cloning/stop-on-error and retained arbitrary callback/getter paths.
- Declared dependencies: `ports:W03.3`, `ports:W03.2`, `ports:W02.5`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Use actual D1/DO parser/controlled producer ownership; annotation, freezing, arbitrary StoragePort output or inspection never certify inertness. Prepared/unprepared outputs/errors/identity/clone and stop-on-error traces match across invalid fields/lifecycle/presence/proxies/sparse/aliased data; no load/query/invoke/commit capability enters facts.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/prepared-ts.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/trace-parity.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Original host shells and unrelated accepted TS workflows remain, but prepared kernel demand extraction/closed producer provenance and full legacy-vs-prepared trace proof are absent.
- Scoped evidence: [packages/work/src/dispatch/index.ts](../../packages/work/src/dispatch/index.ts), [packages/work/src/recovery/index.ts](../../packages/work/src/recovery/index.ts), [packages/work/src/receipt/index.ts](../../packages/work/src/receipt/index.ts), [packages/cloudflare/src/runtime/invoke.ts](../../packages/cloudflare/src/runtime/invoke.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W04.1 — Port native ordered rows and identity sets

- [ ] **Acceptance evidence missing** · `ports:W04.1` · REQUIRED
- Review each native branch against exact original-donor vectors/fault/UTF-16/number/host-reference policy and record branch acceptance; do not count VERSION-only Cargo check as compiled decision module proof.
- Declared dependencies: `ports:W02.2`, `ports:W03.1`, `ports:C03.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Native row/identity/set vectors agree with independent TS oracle for shape, first fault, metadata/presence, count rounding and lossless UTF-16; no host I/O. Done for this branch: implementation plus native test vectors/source review are ready for integrator registration; assembled native compile and differential execution are certified by W04.4 before W04 closes.
- Defining-owner paths from the old plan: `packages/work-kernel/decisions/rows.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Standalone Rust decision bodies and immutable-oracle-oriented vectors exist; audit ran all seven files (242 tests). Branch source-review acceptance not recorded; Cargo/ABI assembly remains W04.4.
- Scoped evidence: [packages/work-kernel/decisions/rows.rs](../../packages/work-kernel/decisions/rows.rs), [packages/work-kernel/decisions/retry.rs](../../packages/work-kernel/decisions/retry.rs), [packages/work-kernel/decisions/every.rs](../../packages/work-kernel/decisions/every.rs), [packages/work-kernel/decisions/lifecycle.rs](../../packages/work-kernel/decisions/lifecycle.rs), [packages/work-kernel/decisions/receipt.rs](../../packages/work-kernel/decisions/receipt.rs), [packages/work-kernel/decisions/recovery.rs](../../packages/work-kernel/decisions/recovery.rs), [packages/work-kernel/decisions/linkage.rs](../../packages/work-kernel/decisions/linkage.rs), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W04.2 — Port native retry, recurrence and lifecycle decisions

- [ ] **Acceptance evidence missing** · `ports:W04.2` · REQUIRED
- Review each native branch against exact original-donor vectors/fault/UTF-16/number/host-reference policy and record branch acceptance; do not count VERSION-only Cargo check as compiled decision module proof.
- Declared dependencies: `ports:W02.3`, `ports:W03.1`, `ports:C03.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Native supplied-sample backoff/slot/coalescing/classification matches fractional/wide-number/error cases; clock/RNG/hash/provider/security operations stay host-owned. Done for this branch: implementation plus native test vectors/source review are ready for integrator registration; assembled native compile and differential execution are certified by W04.4 before W04 closes.
- Defining-owner paths from the old plan: `packages/work-kernel/decisions/retry.rs`, `packages/work-kernel/decisions/every.rs`, `packages/work-kernel/decisions/lifecycle.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Standalone Rust decision bodies and immutable-oracle-oriented vectors exist; audit ran all seven files (242 tests). Branch source-review acceptance not recorded; Cargo/ABI assembly remains W04.4.
- Scoped evidence: [packages/work-kernel/decisions/retry.rs](../../packages/work-kernel/decisions/retry.rs), [packages/work-kernel/decisions/every.rs](../../packages/work-kernel/decisions/every.rs), [packages/work-kernel/decisions/lifecycle.rs](../../packages/work-kernel/decisions/lifecycle.rs), [packages/work-kernel/decisions/rows.rs](../../packages/work-kernel/decisions/rows.rs), [packages/work-kernel/decisions/receipt.rs](../../packages/work-kernel/decisions/receipt.rs), [packages/work-kernel/decisions/recovery.rs](../../packages/work-kernel/decisions/recovery.rs), [packages/work-kernel/decisions/linkage.rs](../../packages/work-kernel/decisions/linkage.rs), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W04.3 — Port native receipt, recovery and linkage decisions

- [ ] **Acceptance evidence missing** · `ports:W04.3` · REQUIRED
- Review each native branch against exact original-donor vectors/fault/UTF-16/number/host-reference policy and record branch acceptance; do not count VERSION-only Cargo check as compiled decision module proof.
- Declared dependencies: `ports:W02.4`, `ports:W03.1`, `ports:C03.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Native ordered batch decisions/faults/ref indices and proposed conditional writes agree with separate stored-pending and wrapper profiles; no stronger converse linkage policy. Done for this branch: implementation plus native test vectors/source review are ready for integrator registration; assembled native compile and differential execution are certified by W04.4 before W04 closes.
- Defining-owner paths from the old plan: `packages/work-kernel/decisions/receipt.rs`, `packages/work-kernel/decisions/recovery.rs`, `packages/work-kernel/decisions/linkage.rs`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Standalone Rust decision bodies and immutable-oracle-oriented vectors exist; audit ran all seven files (242 tests). Branch source-review acceptance not recorded; Cargo/ABI assembly remains W04.4.
- Scoped evidence: [packages/work-kernel/decisions/receipt.rs](../../packages/work-kernel/decisions/receipt.rs), [packages/work-kernel/decisions/recovery.rs](../../packages/work-kernel/decisions/recovery.rs), [packages/work-kernel/decisions/linkage.rs](../../packages/work-kernel/decisions/linkage.rs), [packages/work-kernel/decisions/rows.rs](../../packages/work-kernel/decisions/rows.rs), [packages/work-kernel/decisions/retry.rs](../../packages/work-kernel/decisions/retry.rs), [packages/work-kernel/decisions/every.rs](../../packages/work-kernel/decisions/every.rs), [packages/work-kernel/decisions/lifecycle.rs](../../packages/work-kernel/decisions/lifecycle.rs), [/private/tmp/canlang-consolidation-audit/REPORT.md](/private/tmp/canlang-consolidation-audit/REPORT.md), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W04.4 — Register native modules and run shared conformance

- [ ] **Not implemented / no execution evidence** · `ports:W04.4` · REQUIRED
- Register decisions under the actual Cargo root, reconcile their shared data types, and run immutable current/prepared/native conformance plus locked test/fmt/clippy and host-authority import review.
- Declared dependencies: `ports:W04.1`, `ports:W04.2`, `ports:W04.3`, `ports:W03.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Only integrator edits lib.rs/module registrations; matching immutable vectors drive native and prepared TS outputs. Run cargo test --locked, cargo fmt --check and cargo clippy --locked --all-targets -- -D warnings; inspect imports/features for forbidden host authority, preserve exact faults and materialization demand.
- Defining-owner paths from the old plan: `packages/work-kernel/decisions/lib.rs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/native-conformance.json`, `packages/work-kernel/Cargo.toml`, `packages/work-kernel/Cargo.lock`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Cargo root points to rust/lib.rs exporting VERSION only, excludes decisions/*.rs, and has no assembled native/shared differential registration.
- Scoped evidence: [packages/work-kernel/Cargo.toml](../../packages/work-kernel/Cargo.toml), [packages/work-kernel/Cargo.lock](../../packages/work-kernel/Cargo.lock), [packages/work-kernel/rust/lib.rs](../../packages/work-kernel/rust/lib.rs), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W05.1 — Build pinned package-specific Wasm adapter and bootstrap

- [ ] **Not implemented / no execution evidence** · `ports:W05.1` · REQUIRED
- Implement and prove: Implement pinned build:wasm/glue toolchain against Cargo binding version; compile wasm32 target and use one synchronously callable initialized instance.
- Implement and prove: Select TS/Rust before evaluating operations; selected Rust missing/corrupt/ABI/init errors fail visibly, no lazy call bootstrap or fallback rerun.
- Declared dependencies: `ports:W04.4`, `ports:W03.2`, `ports:C04.ready`, `ports:C04.graph`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Implement pinned build:wasm/glue toolchain against Cargo binding version; compile wasm32 target and use one synchronously callable initialized instance. Select TS/Rust before evaluating operations; selected Rust missing/corrupt/ABI/init errors fail visibly, no lazy call bootstrap or fallback rerun.
- Defining-owner paths from the old plan: `packages/work-kernel/bindings/wasm.rs`, `packages/work-kernel/bindings/loader.ts`, `packages/work-kernel/src/backend.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/assets.json`, `packages/work-kernel/package.json`, `packages/work-kernel/Cargo.toml`, `packages/work-kernel/Cargo.lock`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/work-kernel/package.json](../../packages/work-kernel/package.json), [packages/work-kernel/Cargo.toml](../../packages/work-kernel/Cargo.toml), [packages/work-kernel/Cargo.lock](../../packages/work-kernel/Cargo.lock), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W05.2 — Submit package-specific vendor/build/release integration request

- [ ] **Not implemented / no execution evidence** · `ports:W05.2` · REQUIRED
- Implement and prove: Provide exact vendor/work-kernel entry, bare-import rewriting, binary asset/integrity and required dist-root manifest facts to C04 owner; do not edit bundle.ts, local-run.ts, testkit globals, root build or root lock.
- Implement and prove: Done when exact generated asset hashes/import keys/shipping requirements and loader contract are accepted by the C04 owner; request publication is not final generated-binary delivery proof.
- Declared dependencies: `ports:W05.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Provide exact vendor/work-kernel entry, bare-import rewriting, binary asset/integrity and required dist-root manifest facts to C04 owner; do not edit bundle.ts, local-run.ts, testkit globals, root build or root lock. Done when exact generated asset hashes/import keys/shipping requirements and loader contract are accepted by the C04 owner; request publication is not final generated-binary delivery proof.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/delivery-request.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W05.3 — Verify actual staged workerd binary and loader failures

- [ ] **Not implemented / no execution evidence** · `ports:W05.3` · REQUIRED
- Implement and prove: Run package build:wasm and cargo --features wasm-bindings plus owning C04 actual module-map workerd checks; use non-UTF8 bytes, compare written hashes, missing/corrupt/wrong ABI and cold/warm bootstrap.
- Implement and prove: Prove one instance across bundled/vendor consumer paths and text-only legacy byte parity; installed package acceptance does not rely on source checkout imports.
- Declared dependencies: `ports:W05.4`, `ports:C04.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Run package build:wasm and cargo --features wasm-bindings plus owning C04 actual module-map workerd checks; use non-UTF8 bytes, compare written hashes, missing/corrupt/wrong ABI and cold/warm bootstrap. Prove one instance across bundled/vendor consumer paths and text-only legacy byte parity; installed package acceptance does not rely on source checkout imports.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/delivery.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/loader-errors.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W06.1 — Join state staging and assertions to the selected pure kernel

- [ ] **Not implemented / no execution evidence** · `ports:W06.1` · REQUIRED
- Implement and prove: Retain original expectedVersion and host expectedRevision timing, reader-only stages, pending-versus-running outcome rules, loader-owned delivery membership and wrapper fault order.
- Implement and prove: Linkage assertion stays before one store commit; raw admission hashing/replay/age/auth/normalization and current rejection-receipt behavior stay in owning host.
- Declared dependencies: `ports:W05.3`, `ports:W02.5`, `ports:W03.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Retain original expectedVersion and host expectedRevision timing, reader-only stages, pending-versus-running outcome rules, loader-owned delivery membership and wrapper fault order. Linkage assertion stays before one store commit; raw admission hashing/replay/age/auth/normalization and current rejection-receipt behavior stay in owning host.
- Defining-owner paths from the old plan: `packages/state/src/fanout/tables.ts`, `packages/state/src/fanout/outcome.ts`, `packages/state/src/ports/transact.ts`, `packages/state/src/receipt/tables.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/state/src/fanout/tables.ts](../../packages/state/src/fanout/tables.ts), [packages/state/src/fanout/outcome.ts](../../packages/state/src/fanout/outcome.ts), [packages/state/src/ports/transact.ts](../../packages/state/src/ports/transact.ts), [packages/state/src/receipt/tables.ts](../../packages/state/src/receipt/tables.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W06.2 — Join canonical Cloudflare runtime through existing producer seams

- [ ] **Not implemented / no execution evidence** · `ports:W06.2` · REQUIRED
- Implement and prove: Single integrator replaces only matching decode/outcome/staleness/decision mechanisms in real F7/recovery consumer; fresh guard/authority/evidence/reloads/claim and child-unit commits remain TS.
- Implement and prove: Exercise actual bound binary with canonical source+intent/claim/record/progress/recovery/replay flow; membership cutoff does not grant authority and no terminal child is reinvoked.
- Declared dependencies: `ports:W06.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Single integrator replaces only matching decode/outcome/staleness/decision mechanisms in real F7/recovery consumer; fresh guard/authority/evidence/reloads/claim and child-unit commits remain TS. Exercise actual bound binary with canonical source+intent/claim/record/progress/recovery/replay flow; membership cutoff does not grant authority and no terminal child is reinvoked.
- Defining-owner paths from the old plan: `packages/cloudflare/src/runtime/invoke.ts`, `packages/cloudflare/src/runtime/work-kernel-pilot.test.ts`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [packages/cloudflare/src/runtime/invoke.ts](../../packages/cloudflare/src/runtime/invoke.ts), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W06.runtimehandoff — Release canonical runtime file to validation owner

- [ ] **Not implemented / no execution evidence** · `ports:W06.runtimehandoff` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in work-transitions.md; retain explicit supported/retained/deferred scope.
- Record exact reviewed invoke.ts source hash, exports/producer seams and work consumer traces; no work lane writes runtime/invoke.ts after this handoff.
- Validation canonical runtime writer depends on W06.runtimehandoff in root global DAG; state pure validation can proceed earlier. Integrator resolves queued patches serially and refreshes downstream fixtures against final runtime source.
- Declared dependencies: `ports:W06.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Record exact reviewed invoke.ts source hash, exports/producer seams and work consumer traces; no work lane writes runtime/invoke.ts after this handoff. Validation canonical runtime writer depends on W06.runtimehandoff in root global DAG; state pure validation can proceed earlier. Integrator resolves queued patches serially and refreshes downstream fixtures against final runtime source.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/runtime-source-map.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/runtime-owner.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W06.3 — Prove D1/DO race, crash and restart pilot with actual binary

- [ ] **Not implemented / no execution evidence** · `ports:W06.3` · REQUIRED
- Implement and prove: Run real staged Wasm inside workerd, retain file-backed persist dirs, dispose/kill and fresh boot; Node Wasm plus RPC store proxy alone is insufficient.
- Implement and prove: Exactly one winner per existing claim/child commit unit, atomic terminal outcome/checkpoint with domain/history/replay/outbox/schedule, fresh siblings/revocation and refusal/error/caller retry behavior.
- Implement and prove: Uncertainty/not-found-to-delivered action-time evidence races and held/awaiting progress remain unresolved until real evidence; exceptions commit nothing except explicitly owned canonical rejected receipt path.
- Implement and prove: Run against final canonical runtime source after validation V09.1 completes its last runtime/invoke.ts write; this coordinated source-stability dependency is not a requirement for work pure modules or the early package foundation.
- Declared dependencies: `ports:W06.runtimehandoff`, `ports:W05.3`, `ports:V09.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Run real staged Wasm inside workerd, retain file-backed persist dirs, dispose/kill and fresh boot; Node Wasm plus RPC store proxy alone is insufficient. Exactly one winner per existing claim/child commit unit, atomic terminal outcome/checkpoint with domain/history/replay/outbox/schedule, fresh siblings/revocation and refusal/error/caller retry behavior. Uncertainty/not-found-to-delivered action-time evidence races and held/awaiting progress remain unresolved until real evidence; exceptions commit nothing except explicitly owned canonical rejected receipt path. Run against final canonical runtime source after validation V09.1 completes its last runtime/invoke.ts write; this coordinated source-stability dependency is not a requirement for work pure modules or the early package foundation.
- Defining-owner paths from the old plan: `packages/cloudflare/src/runtime/work-kernel-pilot-durable.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/durable/pilot.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W07.1 — Verify persisted bytes, backend swaps and mixed-failure precedence

- [ ] **Not implemented / no execution evidence** · `ports:W07.1` · REQUIRED
- Implement and prove: Three backends match records.data/metadata/receipt raw hash/default/outcome/outbox/schedule/checkpoint bytes; restart TS persistence under Rust and Rust persistence under TS.
- Implement and prove: Test malformed linkage+stale version, valid linkage+stale version+cyclic clone-only state data, then current versions+cyclic data; join→revision/version→serialization error precedence and zero writes match.
- Declared dependencies: `ports:W06.3`, `ports:W03.4`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Three backends match records.data/metadata/receipt raw hash/default/outcome/outbox/schedule/checkpoint bytes; restart TS persistence under Rust and Rust persistence under TS. Test malformed linkage+stale version, valid linkage+stale version+cyclic clone-only state data, then current versions+cyclic data; join→revision/version→serialization error precedence and zero writes match.
- Defining-owner paths from the old plan: `packages/work-kernel/conformance/persisted.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/durable/bytes.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/durable/error-order.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W07.2 — Implement reproducible complete-call measurement runner

- [ ] **Not implemented / no execution evidence** · `ports:W07.2` · REQUIRED
- Implement and prove: Define --backend ts|prepared-ts|wasm with identical payloads, evidence/RNG sequences and host storage workloads; record versions/hash/inventory/repetitions and machine-readable output.
- Implement and prove: Integrate C05 local CPU harness, not Worker performance clock; later execution includes conversion/host demand/wall durable time, cold/warm/error distributions and memory/asset metrics.
- Declared dependencies: `ports:W01.4`, `ports:W03.4`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Define --backend ts|prepared-ts|wasm with identical payloads, evidence/RNG sequences and host storage workloads; record versions/hash/inventory/repetitions and machine-readable output. Integrate C05 local CPU harness, not Worker performance clock; later execution includes conversion/host demand/wall durable time, cold/warm/error distributions and memory/asset metrics.
- Defining-owner paths from the old plan: `packages/work-kernel/measurement/complete-calls.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/measurements/environment.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W07.3 — Run final parity, resource and complete-flow measurements

- [ ] **Not implemented / no execution evidence** · `ports:W07.3` · REQUIRED
- Implement and prove: Run existing suites plus W04–W06/proposed conformance and measurement commands against successfully built final sources; no stale-dist passing claims.
- Implement and prove: Report cold/warm/conversion/host demand/full turn/child/recovery, variability, peak/live/linear memory, disposal and bounded batch/cache limits, raw/compressed assets and precommitted budget pass/fail; zero unexplained parity differences.
- Declared dependencies: `ports:W07.1`, `ports:W07.2`, `ports:W06.3`, `ports:C05.ready`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Run existing suites plus W04–W06/proposed conformance and measurement commands against successfully built final sources; no stale-dist passing claims. Report cold/warm/conversion/host demand/full turn/child/recovery, variability, peak/live/linear memory, disposal and bounded batch/cache limits, raw/compressed assets and precommitted budget pass/fail; zero unexplained parity differences.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/measurements/results.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/measurements/resources.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/final/verify.log`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W08.1 — Make explicit native-reuse or prepared-TS benefit decision

- [ ] **Not implemented / no execution evidence** · `ports:W08.1` · REQUIRED
- Implement and prove: Use reviewed root JEV disagreement advice plus source/runtime evidence; enable Rust only for concrete reuse or material complete-call improvement over prepared TS that justifies release cost.
- Implement and prove: Record supported/retained unknown-object/callback/demand loops/host hashing/deferred scheduler coverage and ownership; retain TS is a completed evaluation outcome.
- Declared dependencies: `ports:W07`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Use reviewed root JEV disagreement advice plus source/runtime evidence; enable Rust only for concrete reuse or material complete-call improvement over prepared TS that justifies release cost. Record supported/retained unknown-object/callback/demand loops/host hashing/deferred scheduler coverage and ownership; retain TS is a completed evaluation outcome.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/adoption.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/coverage.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W08.2 — Rehearse release selection, disposal and rollback

- [ ] **Not implemented / no execution evidence** · `ports:W08.2` · REQUIRED
- Implement and prove: Begin disabled/TS default, then reproducible pinned opt-in; no source runtime edit after handoff and no semantic retry after trap/integrity/error.
- Implement and prove: Exercise backend swap on same persisted rows/receipts, clean instance reload/disposed refs, real packaged binary and release verification without deployment/activation; no schema/digest migration.
- Declared dependencies: `ports:W08.1`, `ports:W05.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Begin disabled/TS default, then reproducible pinned opt-in; no source runtime edit after handoff and no semantic retry after trap/integrity/error. Exercise backend swap on same persisted rows/receipts, clean instance reload/disposed refs, real packaged binary and release verification without deployment/activation; no schema/digest migration.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/rollback.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W08.3 — Close source checks and implementation completion ledger

- [ ] **Not implemented / no execution evidence** · `ports:W08.3` · REQUIRED
- Implement and prove: Report refreshed source map, exact commands/results/baseline failures, real installed/durable scope and retained paths; no isolated-native or memory-only completion claim.
- Implement and prove: Each eventual merge handler reconciles living file-tree coverage/decisions against all changes since checkpoint; planning itself performs no merge/checkpoint update.
- Declared dependencies: `ports:W08.2`, `ports:W08.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Report refreshed source map, exact commands/results/baseline failures, real installed/durable scope and retained paths; no isolated-native or memory-only completion claim. Each eventual merge handler reconciles living file-tree coverage/decisions against all changes since checkpoint; planning itself performs no merge/checkpoint update.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/final/source-checks.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/final/completion.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W01 — Capture consumer contracts and behavioral traces — completion gate

- [ ] **Partly implemented / incomplete acceptance** · `ports:W01` · REQUIRED
- Obtain and record exact owner reviews of source/policy/delivery/workload scope and resolve W01.3/W01.4 acceptance gaps before W01 closes.
- Declared dependencies: `ports:W01.1`, `ports:W01.2`, `ports:W01.3`, `ports:W01.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence. Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Evidence-complete contract review explicitly leaves required work/state/Cloudflare/C04/C05 owner approvals PENDING; actual durable baseline/numeric budgets incomplete.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/w01-gate.json](../../docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/w01-gate.json), [docs/ideal-filetree-plan/finished-product/consolidation-review.json](../../docs/ideal-filetree-plan/finished-product/consolidation-review.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W02 — Consolidate matching TypeScript mechanics first — completion gate

- [ ] **Partly implemented / incomplete acceptance** · `ports:W02` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in work-transitions.md; retain explicit supported/retained/deferred scope.
- All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
- Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Declared dependencies: `ports:W02.1`, `ports:W02.foundation`, `ports:W02.2`, `ports:W02.3`, `ports:W02.4`, `ports:W02.5`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence. Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W03 — Prepare closed batch facts and host references — completion gate

- [ ] **Partly implemented / incomplete acceptance** · `ports:W03` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in work-transitions.md; retain explicit supported/retained/deferred scope.
- All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
- Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Declared dependencies: `ports:W03.1`, `ports:W03.2`, `ports:W03.3`, `ports:W03.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence. Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W04 — Implement data-only Rust kernel and native conformance — completion gate

- [ ] **Partly implemented / incomplete acceptance** · `ports:W04` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in work-transitions.md; retain explicit supported/retained/deferred scope.
- All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
- Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Declared dependencies: `ports:W04.1`, `ports:W04.2`, `ports:W04.3`, `ports:W04.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence. Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: Some prerequisite implementation/evidence exists, but the exact aggregate source gate is not closed. No full port/consumer/release/performance acceptance follows.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W05 — Deliver and initialize the actual Wasm consumer — completion gate

- [ ] **Not implemented / no execution evidence** · `ports:W05` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in work-transitions.md; retain explicit supported/retained/deferred scope.
- All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
- Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Declared dependencies: `ports:W05.1`, `ports:W05.2`, `ports:W05.3`, `ports:W05.4`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence. Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W06 — Pilot state staging through actual Cloudflare durable paths — completion gate

- [ ] **Not implemented / no execution evidence** · `ports:W06` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in work-transitions.md; retain explicit supported/retained/deferred scope.
- All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
- Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Declared dependencies: `ports:W06.1`, `ports:W06.2`, `ports:W06.runtimehandoff`, `ports:W06.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence. Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W07 — Differential, persisted-byte and resource gates — completion gate

- [ ] **Not implemented / no execution evidence** · `ports:W07` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in work-transitions.md; retain explicit supported/retained/deferred scope.
- All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
- Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Declared dependencies: `ports:W07.1`, `ports:W07.2`, `ports:W07.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence. Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W08 — Decide adoption, rollout and rollback — completion gate

- [ ] **Not implemented / no execution evidence** · `ports:W08` · REQUIRED
- Review all exact prerequisite tasks and the preserved parent gate contract in work-transitions.md; retain explicit supported/retained/deferred scope.
- All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
- Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Declared dependencies: `ports:W08.1`, `ports:W08.2`, `ports:W08.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence. Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W05.4 — Verify fulfilled assets in outside-checkout install and release

- [ ] **Not implemented / no execution evidence** · `ports:W05.4` · REQUIRED
- Implement and prove: Verify actual packaged installation outside checkout, 0.1.0 release:stamp and required dist/binary manifest coverage; test-loader exclusions remain intact.
- Implement and prove: C04.work-assets fulfils W05.2 after shared graph and independent smoke readiness; verify the final generated kernel/glue, exact vendor/import map, required binary hashes and packaged release outside checkout. The tiny C04.ready smoke alone cannot certify these outputs.
- Declared dependencies: `ports:W05.2`, `ports:C04.work-assets`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Verify actual packaged installation outside checkout, 0.1.0 release:stamp and required dist/binary manifest coverage; test-loader exclusions remain intact. C04.work-assets fulfils W05.2 after shared graph and independent smoke readiness; verify the final generated kernel/glue, exact vendor/import map, required binary hashes and packaged release outside checkout. The tiny C04.ready smoke alone cannot certify these outputs.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/installed-package.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: No task-specific implementation/completion evidence fulfilling this exact acceptance was found. Existing legacy functionality and local tests do not certify the proposed port.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

## Conditional or deferred — work-transitions

### W09.1 — Specify separate request/resume scheduler contract and consultation

- [ ] **Deferred / outside selected required work** · `ports:W09.1` · DEFERRED
- Only upon separate authorization, Separately authorized project only: load/query/checkpoint/snapshot/guard/authority/invoke/final batch requests, exact demand/order, cancellation/disposal, host exceptions/refusals, versions/revisions and caller-owned retries.
- Only upon separate authorization, Get own verified-context three-equivalent JEV review; Rust may request I/O but host owns authority and one final commit submission.
- Declared dependencies: `ports:W08`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Separately authorized project only: load/query/checkpoint/snapshot/guard/authority/invoke/final batch requests, exact demand/order, cancellation/disposal, host exceptions/refusals, versions/revisions and caller-owned retries. Get own verified-context three-equivalent JEV review; Rust may request I/O but host owns authority and one final commit submission.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/scheduler/contract.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: W09 request/resume scheduler is a separate explicitly deferred/authorized project; W01-W08 completion excludes it.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W09.2 — Prototype scheduler only against a real continuation consumer

- [ ] **Deferred / outside selected required work** · `ports:W09.2` · DEFERRED
- Only upon separate authorization, Require a real generated fanout/wait continuation consumer, complete runtime traces/restart proof and bounded retained-state/reuse benefit beyond W08; memory-only proof is insufficient.
- Only upon separate authorization, No-go for reordered/eager auth/callbacks, stale checkpoints, hidden commit/retry loops, broken sync API, unbounded memory or unjustified protocol cost.
- Declared dependencies: `ports:W09.1`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Require a real generated fanout/wait continuation consumer, complete runtime traces/restart proof and bounded retained-state/reuse benefit beyond W08; memory-only proof is insufficient. No-go for reordered/eager auth/callbacks, stale checkpoints, hidden commit/retry loops, broken sync API, unbounded memory or unjustified protocol cost.
- Defining-owner paths from the old plan: `packages/work-kernel/continuations/`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/scheduler/prototype.json`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: W09 request/resume scheduler is a separate explicitly deferred/authorized project; W01-W08 completion excludes it.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W09.3 — Record separate scheduler go/no-go and rollout requirements

- [ ] **Deferred / outside selected required work** · `ports:W09.3` · DEFERRED
- Only upon separate authorization, Own tests/budgets/rollout decision required; do not promote data-only ABI into scheduler silently. W01–W08 completion excludes this optional project.
- Declared dependencies: `ports:W09.2`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: Own tests/budgets/rollout decision required; do not promote data-only ABI into scheduler silently. W01–W08 completion excludes this optional project.
- Defining-owner paths from the old plan: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/scheduler/decision.md`. Reconcile current owners before assigning; proposed filenames/layout are not mandatory.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: W09 request/resume scheduler is a separate explicitly deferred/authorized project; W01-W08 completion excludes it.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.

### W09 — Deferred request/resume scheduler contract, separate go/no-go — completion gate

- [ ] **Deferred / outside selected required work** · `ports:W09` · DEFERRED
- Only upon separate authorization, All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
- Only upon separate authorization, Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Declared dependencies: `ports:W09.1`, `ports:W09.2`, `ports:W09.3`. Narrow released interfaces may permit a scoped slice before a broad parent closes.
- Close when: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence. Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
- Source: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json)
- Current basis: W09 request/resume scheduler is a separate explicitly deferred/authorized project; W01-W08 completion excludes it.
- Scoped evidence: [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.tasks.json), [docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md](../../docs/research/package-subsystem-ports-20261006/implementation-plans/work-transitions.md). Exact revisions, claims and limits are retained in `tasks.json`; these links do not claim fresh execution.
