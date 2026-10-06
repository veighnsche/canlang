# input-validation.md plan audit (review only, no implementation)

Audited: 2026-10-06. Plan checkpoint: `3d1f8f0`. Audit head: `264de56`
(`audit/input-validation-review`). Method: source re-read at both revisions,
mechanical md↔JSON cross-checks, evidence-tree inventory. Every claim below
names its check.

## Verified — no action

- **md↔tasks.json mirror exact**: 73/73 task IDs present in both;
  Files/output↔writes match 73/73 with 0 mismatches (scripted).
- **All dependencies resolve**: every `depends_on` hits a real ID — internal
  V, shared C, exact-values A, or work `W06.runtimehandoff`. No dangling IDs.
- **Lane ownership disjoint and covering**: 9 lanes pairwise file-disjoint;
  every task package write is owned by its lane (V-evidence covers its
  conformance files via the owned `owned-input/v1/` directory prefix).
- **Source-map anchors accurate at checkpoint**: spot-verified
  `values/src/schema.ts:139/217/339` (descriptors, NormalizedSchema, guard)
  and `interfaces/src/http/limits.ts:38/72/94` (capped reader, JSON/form
  parsers) against `3d1f8f0` content.
- **Values/interfaces anchor-stable to HEAD**: no diff `3d1f8f0→264de56` in
  `values/src/{schema,wire}.ts`, `interfaces/src/http/{limits,operations}.ts`
  (agrees with V01.1 byte-identical claim); `state` admission anchors
  `:83/:299` content-stable across its 14-line delta.
- **Material-gap claims hold**: interim HTTP 501 naming the join plus the real
  `handleOperationRequest` both present (`worker/assembly.ts`,
  `interfaces/src/http/operations.ts`); sampled A1–A4 paths exist;
  "four diagnostics" matches `full-evaluation.md:148`; `conformance/v1`
  exists while `conformance/owned-input` is absent as proposed.
- **V01 evidence complete per spec**: all six specified files plus
  `v01-review.md` (all four children PASS, consistent head `bb479c2`).

## Gaps and risks

1. **Cloudflare anchors stale at HEAD** (medium). `worker/assembly.ts`
   grew +255 lines since the checkpoint; plan anchors `:744/:1010/:1120`
   now point at different content (verified then/now). `runtime/invoke.ts`
   moved ±650. The plan anticipates a refresh ("must refresh them in its
   final report"), but Wave 2+ workers reading anchors literally at HEAD
   will misland. Recommend a refreshed anchor note before V02.3/V08.1.
2. **A-gate evidence absent; C04.ready absent** (high for schedule).
   `evidence/implementation/exact-values/` holds only `core/contracts.md` —
   no `A03.foundation`/`A04.5`/`A05.3`/`A04.2`/`A07.foundation`/`A07`
   artifacts; `shared/` has C01/C02/C03/C05 ready but no `C04.ready.json`.
   Blocked until those land: V03.1, V03.3, V03.5, V04.1, V06.1, V06.3,
   V06.8, V08.1, V10.3 (transitively everything Rust-side).
3. **V10.1/V10.2 unstarted** (medium). No `mcp-provenance.md` or
   `forms-provenance.md`; both are C01.ready-gated Wave 1 tasks that could
   run now. Until they land, MCP/forms stay deferred-unknown and V10 cannot
   close.
4. **No execution-status tracking** (low). All 73 md boxes unchecked and no
   `status` field in any tasks.json, despite V01.1–V01.4 evidence plus a
   PASS review being integrated. The review correctly notes gate release
   belongs to the coordinator — but nothing distinguishes "evidence
   produced" from "accepted", so readiness is only determinable by
   evidence-tree spelunking (as done here).
5. **Critical path**: V01 coordinator release + `A03.foundation` evidence.
   Once V01 releases, C02/C05 readiness already present unlocks
   V02.1/V02.3/V02.4/V02.5 (then V02.2, V11.1) — the prepared-TS chain can
   run ahead of all Rust gates.

## Out of scope (not checked)

Line-by-line re-verification of all ~35 source anchors; V01 evidence
content correctness beyond inventory/review-ledger consistency; JEV/ABI
design judgment; whether `bb479c2→264de56` deltas affect V01 baselines.
