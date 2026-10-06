# T34 implementation slice plan (planning only — no code)

Writer: T34-prep evidence writer. Status: **PLAN — implements NOTHING.**
Ordered slice breakdown for T34 (adopted T33-A durable per-child
fanout). Sources read in full: `t33-resolution.md` (ADOPTED A contract
+ Item-10/T34 matrix, Codex-owned read-only), tasks.md T34 row +
T24/T32 evidence, `design/jev/t33-context-correction-20261006/README.md`
(advice, not implementation). Contract transcription lives in
`fanout-decision.md` §R10-FULL (§C1–§C9, §M1–§M10); cites below reuse
those labels. No builds, no tests, no Git. Coordinator assigns writers
and exact reservations at dispatch; this plan proposes them.

## 1. Dependency ledger (observed, with cites)

| Dependency | Status | Cite |
| --- | --- | --- |
| T24 dispatch substrate | DONE (ticked COMPLETE) | tasks.md:224 |
| T32 fence substrate | DONE (checkpoint_fence A adopted + fence/wire/cloudflare landed) | tasks.md:280 |
| T33 adoption | ADOPTED A (both `each=` spellings) | t33-resolution.md:13 |
| T25a receipt/observation | LANDED (9830ba9, writers released; joins need not serialize behind it) | tasks.md:287 |
| T28 containment | ADOPTED A; all four fanout cohort parents package-local | tasks.md:252; fanout-decision.md §3 |
| T18 defaults/execution | ACTIVE (Evidence: pending) — L1/L3 T34 joins serialize AFTER its release | tasks.md:177-182 |
| T29 imported containment | PENDING (Evidence: pending) — NOT on T34 critical path (no fanout site traverses an imported parent); conditional join only if the adopted cohort language later does | tasks.md:254-259 |
| T34 row files | work dispatch/recovery/kernel-tables + contracts/work.ts + owning compiler/state/assembly handoffs | tasks.md:289-294 |

Retained limits (t33-resolution.md:48): T08 parity, T16c/T17 limits,
deploy failures (T21-owned), separate D closure and cleanup.

## 2. Explicitly OUT of T34 (tracked remainders, not T34's)

- Bound sends / B8 Handbook executable interface (L4-owned E3019).
- Cross-store atomicity (never inferred; t33-resolution.md:21,25).
- Narrower per-team/per-record fence (T32 remainder).
- `active_member` checker sharing (T32 remainder; hand-rolled checks exist).
- Any numeric deployment quota (resolution forbids: :25).
- Any new authoring syntax incl. a skipping/suppression rule (resolution
  forbids: :24; §C8 default is no-automatic-supersession).

## 3. Ordered slices

### F1 — Fanout contract records (L4, may precede T18)

- Files: `packages/contracts/src/work.ts` ONLY (+ coordinator-assigned
  contract tests in the owning package).
- Deps: T33-adopted; builds on LANDED T25a records (no serialization wait).
- Acceptance: §M3 (identity = parent+handler+record), §M6
  (retry/exhaustion attribution shape), §M10 (diagnosis shapes for
  unsupported/cross-owner/unavailable-membership).
- Must prove: closed record vocabulary (fanout intent, checkpoint,
  child outcome/progress); handler component in identity; NO quota
  field, NO new syntax; tsc green incl. root gate.

### F2 — Kernel tables (L4, may precede T18)

- Files: `packages/work/src/kernel/tables.ts` ONLY (+ owning-package tests).
- Deps: F1; rides T24 table/batch precedents (tasks.md:224).
- Acceptance: §M1 (bounded pages carry 499/500/501/1000), §M2
  (durable checkpoint rows), §M6 (bounded claim/retry state).
- Must prove: durable intent/checkpoint/child-row shapes on D1/DO
  substrates; bounded id-sorted pages; `done:false` means resume, never
  silent truncation; chunk size is not cohort size (§C9).

### F3 — Dispatch child-claim/record (L4, may precede T18)

- Files: `packages/work/src/dispatch/index.ts` ONLY (+ owning-package tests).
- Deps: F1, F2, T24-done, T32-done.
- Acceptance: §M3 (claim under stable identity + receipt replay, no
  duplicated notices/events/checkpoints), §M5 (rejection isolation,
  T32 fence at claim, terminal-with-failures → attention), §M6
  (bounded retries reuse identity, no starvation), §M8 (bounded
  scheduling progresses all).
- Must prove: exactly-one-winner claim per child identity;
  claim-time guard re-evaluation on a CURRENT snapshot;
  refused-revoked / refused-inherited-scope preserved (T32 wire);
  per-child retry horizon + dead-letter visibility; aggregate
  attention (never success) when terminal failures exist.

### F4 — Recovery + enumeration resume (L4, may precede T18)

- Files: `packages/work/src/recovery/index.ts` ONLY (+ owning-package tests).
- Deps: F1, F2, T24-done.
- Acceptance: §M2 (crash at enumeration/claim/effect/checkpoint
  boundaries; REAL restart on durable substrate), §M4 (exact cutoff;
  no phantom/lost member), §M7 (independent occurrences both retain
  coverage; no auto-supersession).
- Must prove: recovery-scan plan over fanout rows (claimed+stale →
  resume; pending+guard-false → skipped; exhausted → dead); no lost
  identity; no acknowledged unfinished effect; committed child effects
  never re-executed; uncertain rows observed read-only (T24 precedent).

### F5 — L3 state join: membership + atomic child checkpoint (AFTER T18)

- Files: OWNING L3 WRITER handoff — T18 owns state invoke/admission/
  models/pipeline/crud (tasks.md:177-182). Coordinator assigns exact
  paths at T18 release; this plan reserves the JOIN, not the files.
  Expected surface: staging/transact child-intent join, invoke child
  admission, authoritative membership mechanism, query/engine reads.
- Deps: F1–F4, T18-RELEASED (strictly after), T32-done.
- Acceptance: §M1 (exact membership across bounded enumeration +
  concurrent changes + failures), §M4 (cutoff + current-body/lifecycle
  policy; deleted → explicit skipped/deleted; moved → re-evaluated;
  unknown lookup never deletion), §M5 (T32 fence per child), §C5
  (child unit commits in ONE owner transaction).
- Must prove: frozen identity set (or proven equivalent) at an explicit
  source-occurrence/handler cutoff in the OWNING store; late inserts
  excluded; child domain/history/replay/events/schedules/outbox/
  outcome/checkpoint atomic; membership grants no authority (§C4);
  data minimization on operator progress (§C7).

### F6 — L1 compiler join: check + emit both spellings (AFTER T18)

- Files: OWNING L1 WRITER handoff — T18 owns compiler effects/ir/js/
  artifact + contracts/artifact.ts + codegen.rs (tasks.md:177-182).
  Coordinator assigns exact paths at T18 release.
- Deps: F1, T18-RELEASED (strictly after).
- Acceptance: §M9 checker half (Shift commitment/swap + Volunteer
  refresh/cancel bodies, guards, notices accepted without trimming),
  §M10 (unsupported/cross-owner/unimplemented cohort forms stay
  diagnosed; ordinary bounded-loop overflow still rejects atomically).
- Must prove: `each=` checked for bare-model AND parent-anchored
  reverse-collection spellings; null-or-match filters, sticky
  conflict/obsolete, reminder pairing, version guards preserved (§C4);
  NO new syntax (§C8); E1203 retained exactly for out-of-contract forms.

### F7 — L7 assembly/runtime join: atomic intent staging + fair scheduler

- Files: OWNING L7 WRITER handoff (worker assembly + runtime invoke/
  dispatch wiring). Coordinator assigns exact paths; precedents are the
  T24b seam (`assembleDispatchCommands`) and T32b-cloudflare gate.
- Deps: F1–F4, F5 (membership mechanism must exist to stage against).
- Acceptance: §M2 (fanout intent staged ATOMICALLY with source commit;
  trigger rollback voids both), §M8 (bounded fair scheduler turns;
  provider cancellation only per its accepted contract), §M1 end to end
  (chunk ≠ cohort through the real path).
- Must prove: source domain truth + durable fanout intent commit
  atomically (§C2); fair resumable scheduling across pages/claims/
  retries; resource exhaustion explicit pre-admission, honest
  pending/attention post-admission (§C9); restarts claimed ONLY with
  real-restart evidence (T24 precedent: unclaimed until proven).

### F8 — Matrix proof + owning-app qualification record

- Files: NEW test files in OWNING packages (coordinator assigns exact
  paths per slice owner) + one new evidence file (proposed:
  `implementation/challenge-audit-run/evidence/fanout-proof.md`;
  coordinator-owned after assignment).
- Deps: F1–F7 (each witness rides its owning slice's landing).
- Acceptance: §M1–§M10 ALL witnessed; T40 stays BLOCKED until matching
  T34/checker/emission/authority/fixture joins pass (§M9).
- Must prove, per row with named test + substrate (memory shape vs
  D1/DO durable vs REAL restart): M1 499/500/501/1000 one-outcome-each
  + inline-overflow rejection; M2 real-restart resume at all four
  boundaries; M3 duplicate-delivery replay; M4 insert/move/delete
  cutoff exactness; M5 revocation/rejection isolation + attention;
  M6 exhaustion attribution + fairness under stall; M7 two filtered
  occurrences retain coverage; M8 bounded-turn progress; M9 unchanged
  Shift/Volunteer workflows; M10 every negative control failing.

## 4. Serialization order

```
F1 ──► F2 ──► F3 ──► F7 ──┐
  \         \       /      ▼
   \────────► F4 ──►      F8 (proof over all)
                    ▲
F5 (L3 join, AFTER T18 release) ──┘
F6 (L1 join, AFTER T18 release) ──► F8 only
```

- Work-kernel slices F1–F4 may precede T18 (L4-owned files, disjoint
  from T18's L1/L3 reservations).
- F5/F6 dispatch ONLY after verified T18 writer release + exact
  reservations (t33-resolution.md:48).
- T34 completes ONLY with the full membership/identity/checkpoint/
  recovery contract + proofs; partial slices never tick the parent.

## 5. Exact open questions (no answers invented)

1. Which lane owns the authoritative membership mechanism implementation
   (L3 state query/engine vs L4 work-kernel tables), and what are its
   exact file reservations?
2. Is F5 dispatched as a T34 slice or as a separate T18-followup task
   with its own evidence line?
3. Exact new test-file paths for F8 in each owning package (coordinator
   assigns at dispatch).
4. Frozen identity set vs proven-equivalent membership mechanism: decided
   by the OWNING producer at F5 and recorded before qualification
   (t33-resolution.md:27) — which does the owner choose?
5. Exact page/claim/retry/scheduler-turn bounds: set by the owning
   producer, recorded before qualification (t33-resolution.md:27 —
   no fabricated quota).

## 6. Handoff

- Writer: T34-prep evidence writer. WROTE ONLY this NEW file plus the
  §R10-FULL append to `fanout-decision.md`; all source (state/
  compiler/cloudflare/work/contracts/values/identity), drafts,
  `t33-resolution.md`, the correction dir, tasks.md, and all other
  evidence files untouched; no JEV run; no Git; no builds; no tests run.
- Release: this file is RELEASED to the coordinator.
