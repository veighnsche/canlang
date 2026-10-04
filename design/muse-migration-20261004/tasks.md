# Implementation: finish settled Can/JavaScript draft migrations

## Handoff contract

| ID | Intended behavior / why | Observable acceptance | Source |
| --- | --- | --- | --- |
| Q1 | Token-efficient company SaaS drafts retain real policy and outcomes | Remove repeated mechanics using settled contracts; preserve guards, effect order, evidence and business recovery | User; REQUIREMENTS.md; draft/MIGRATION.md |
| Q2 | Same Can construct has one desired-JS translation | Changed pairs use DESIGN §13 and canonical examples; no invented APIs disguised as existing implementations | User; DESIGN.md |
| Q3 | Routine work is separate from design | Apply settled decisions; report exact unknowns for Astra; no unilateral new primitives/business policy | Current Muse/Astra workload split |
| Q4 | Parallel work has exclusive ownership | Coordinator logs task/file reservations, serializes overlapping writes and commits exact paths; releases writers at handoff | User; muse-implementation skill |

- Scope: `.can`, companion requirements and existing handwritten `.mjs`, plus approved new draft examples after their design handoff. Compiler, standard-library and infrastructure implementations are excluded. Imports remain explicitly proposed contracts.
- Investigation: DESIGN §8.1 already specifies typed associated deliveries; CanContract contains the complete reminder reference, and CanCheck preserves a separate business diagnostic callback. Ten remaining notification mappings were inspected. Six targets remain outside the closed CRUD/hook correspondence slice. All 194 read policies already had a bounded correspondence check; do not repeat it absent a relevant edit.
- Selected design: use canonical `delivery(Target)` and existing `send`/`set`, safe authorized leaf projections and derived status. Do not erase business state, frozen recipients/revisions, current-attempt correlation, diagnostics or permission checks. Canonical structure is in DESIGN §13; `.mjs` dependencies are unimplemented contracts. See design/delivery-association-20261004.md, design/delivery-recipe-overrides-20261004.md and current migration evidence.
- Alternatives needing design: new population enumeration, retained typed history, optional integration closure and new AI contracts remain unresolved. They are gated tasks below, never routine guesses.
- Strategy: one Muse coordinator and at most THREE active implementation agents, each on one small task. Shared checkout, no extra worktrees or caches. Each agent receives only relevant context. Contract application precedes correspondence review of the same file; disjoint files run concurrently. No arbitrary overall duration/step/token budget.
- Repository rules: read AGENTS.md and REQUIREMENTS.md. One-space Can indentation, `#` descriptions, `##` explanatory comments, meaningful inline examples, shared @canlang/ui components, no h/Preact. Keep app identity/import ownership and current authority intact. Never simplify away required behavior for line count.
- Verification: focused Node syntax for changed targets; applicable prototype parsing with unsupported forms disclosed; compare affected source/target guards, effects, grants and expected outcomes. No broad builds, runtime claims or new verification frameworks. Retain compact evidence, not full transcripts/source copies.
- Monitoring record: /Users/vince/Projects/canlang/design/muse-migration-20261004/monitor.md
- Communication: /Users/vince/Projects/canlang/design/muse-migration-20261004/inbox.md is Codex/Astra's one-way design handoff. Muse alone updates this checklist's progress and acknowledgments. Codex owns monitor/inbox/design documents. Implementation agents never edit the checklist.

Muse must call its native create_goal BEFORE delegating: complete every Muse-owned ready task and integration join in this checklist, consume released design handoffs, and return evidenced work with all writers released for independent Codex review. On continuation get_goal/reuse the matching goal; do not overwrite unrelated goals. No arbitrary token budget. report_progress reflects evidenced tasks and reaches 100% only at handoff. update_goal complete only when all Muse-owned tasks are satisfied and handoff is ready; unresolved required design tasks mean a blocked handoff, not success. If native goal tools are missing/rejected report that blocker.

## Ownership and file-message protocol

1. Record task reservations and actual session/goal references in the progress ledger below. Coordinator alone stages/commits EXACT task paths, never `git add .`. Other agents never touch Git index. Codex/Astra do not commit concurrently during Muse ownership.
2. Read inbox at startup, before each assignment, after each agent result and on supported native goal wakes. While waiting on design, check for changes no more often than every two minutes using supported native waiting; no busy polling or second coordinator. If no supported idle wait/wake exists, report that limitation and hand off BLOCKED with writers released; Codex can notify the same session using the installed session-message command. Do not pretend a file write itself injects a message into an idle TUI.
3. Inbox entries have unique H IDs and kind NOTE, RELEASE-REQUEST, READY or DESIGN-CLOSED. Acknowledge each new ID in the progress ledger, including accepted/blocked and exact affected tasks. READY supplies a concrete linked contract/witness and releases a predeclared gated task. A proposal without READY is not authorization to adopt it.
4. A RELEASE-REQUEST requires stopping/finishing affected tasks safely, obtaining every relevant agent's release, and recording `RELEASED Hxxx: files`. Codex only then edits that task plan/shared interface. Do not apply interface changes under an active writer. Continuing unrelated tasks is permitted.
5. New scope outside the finite tasks below requires this release/plan amendment; do not manufacture tasks. All ready tasks exhausted while design remains open means waiting or a truthful blocked handoff, not a completed goal. Root will send DESIGN-CLOSED when the current design handoffs have final dispositions.
6. Routine reinspection of long commands waits 1–5 minutes, default 2, from last check. Use native bash initial yield_time_ms:120000 (60000–300000 supported range). Retain handle/deadline in Muse command state; goal wakeups do not reset it or cause empty bash_input polling. Await automatic completion, inspect background commands only when runtime-overdue. Act immediately on delivered completion/failure/input/approval or intervention. Preserve deadlines across surfaced shorter caps or report limits; no invented timers, duplicate commands or busywork. Include this paragraph in agent prompts.
7. For a genuine design question, record affected task/lines, competing meanings and evidence. Root/Astra resolves it. Do not independently repeat or bypass previously rejected JEV payloads. Difficult new decisions follow three fully reworded equivalent consultations and saved uncertainty, without treating advice as proof.

## Tasks

- [x] **M00 — Native goal, ownership and inbox acknowledgment**
  - Prerequisites: None
  - Owner / files / interfaces: Muse coordinator; this checklist progress; read monitor/inbox only
  - Changes / traceability: Q3/Q4; create native goal, verify selected model/MAX, record session/goal identity; acknowledge H001 and assign nonoverlapping tasks.
  - Acceptance: Native goal exists before delegation, exact reservations and no competing Muse coordinator.
  - Evidence: goal-01a106e7-cffe-7b52-a3e5-858eff4a04fe session 01a106e7-49b5-7543-b54f-eb6ad9540769; peer_sessions=[] no competing coordinator; workspace /Users/vince/Projects/canlang main f5dddbe clean; approval bypassed/sandbox off/worktree off; H001 acknowledged; first reservations D01/D02/D03 disjoint.

- [x] **D01 — Book notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanBook.can, draft/CanBook.md; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: writer 01a106e9-5e60-7ab0-baaa-f3a392f581ac released. Notice.delivery text→delivery(Mail.send), derived state (Delivered=succeeded caption), policies +delivery.id/.status leaves, producers store handle, pure notice_result removed, reminder example asserts pending. Coordinator verified diff vs Contract/Shift patterns; independent projection parse exit 0; guards/effects/grants/outcomes compared; no design question. Post-release coordinator repair: added missing use std {DeliveryResult} (Grant/Mail convention), re-verified projection parse exit 0.

- [x] **D02 — Catch notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanCatch.can, draft/CanCatch.md; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: writer 01a106e9-5fa5-7173-b4db-affb9fe22fe7 released. Notice.delivery text?→delivery(Alerts.notify)?, derived outcome, policies +delivery.id/.status, detail kept as retained safe diagnostic, producers store handle, callback correlates delivery?.id with diagnostic-only effect, 2 operation-resolved recipes, callback table 3→5 rows incl stale-ignore. Coordinator verified vs Check pattern; projection parse exit 0; no design question.

- [x] **D03 — Desk notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanDesk.can, draft/CanDesk.md; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: writer 01a106e9-60b0-7df1-8514-c73fee43624e released. Message.delivery text?→delivery(Mail.send)? + use std {DeliveryResult}, stored state→derived status? (Queued/Sent captions kept; null=not-requested for customer/notes, kind preserves inbound distinction), customer policy +delivery.status leaf only, reply producer stores handle, pure sent callback + 3 tables removed, reply examples +fresh pending + new 6-row observation table (5 states + null). Coordinator verified import convention, no stale state refs, projection parse exit 0; no design question.

- [x] **D04 — Event notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanEvent.can, draft/CanEvent.md; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: writer 01a106ee-0d5e-78e0-82aa-3296498e1fad released. Notice.delivery text unique→delivery(Mail.send), stored state→unlabeled derived status, acceptance-reference copy removed with its 2 UI columns (Mail transport-evidence precedent; no guard/effect consumed it; resend keys on state+revision), policies +delivery.id/.status, producers store handle, pure notice_result removed, new 4-row dispatch table (pending/skipped/rule_failed). Charge/refund/reconcile bookkeeping untouched. Coordinator verified no stale refs, projection parse exit 0; no design question.

- [x] **D05 — Hire notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanHire.can, draft/CanHire.md, draft/CanHire.mjs; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: writer 01a106ee-0e65-7670-9327-063030f84315 released. notice_delivery text?→delivery(Mail.send)? + use std {DeliveryResult}, stored notice_state→derived status?, producer stores handle, pure reminder_result removed; release/reservation IDs untouched. Target: delivery schema (hire.Mail.send), derived block + derives registry (Grant convention), registry/handler removal mirrored. No remind examples pre-existed; none stale. Coordinator verified node --check OK + projection parse exit 0 (only pre-existing sequence projected out); no design question.

- [x] **D06 — Loyalty notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanLoyalty.can, draft/CanLoyalty.md, draft/CanLoyalty.mjs; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: writer 01a106f0-8288-7af3-9d03-2340cfca77f1 released. notification_delivery text?→delivery(Mail.send)?, stored notification→derived status? (name kept), import split per local-vs-bound rule, producer stores handle, pure notification callback + table removed; redeem examples +pending, new 6-row fulfill observation table (5 states + null). Target: delivery schema (loyalty.Mail.send), derived + derives entries, fixture recipe + both table mirrors, removal mirrored. Coordinator verified node --check OK, projection parse exit 0, no stale refs; no design question. J02 now unblocked (awaits dispatch).

- [x] **D07 — Maintain notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanMaintain.can, draft/CanMaintain.md, draft/CanMaintain.mjs; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: writer 01a106f4-0f69-72b2-8ce3-c7987750d3ff released. Notice.delivery text→delivery(Mail.send) + use std {DeliveryResult}, stored state→derived status (Superseded caption kept), producers store handle, retry require preserved over derived reads, guarded pure notice_result removed. Repair block/affected IDs untouched; Notice policy full grant unchanged (Hire/Loyalty precedent; §8.1 disclosure gating). Target: delivery schema (maintain.Mail.send), derived + non-null derives form, guard/predicate helper reads, removal mirrored. Coordinator verified node --check OK, projection parse exit 0 (3 pre-existing sequences projected out), no stale refs; no design question.

- [x] **D08 — Reception notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanReception.can, draft/CanReception.md; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: writer 01a106f4-105e-79b1-a7d5-325dfb6472d1 released. notice_delivery text?→delivery(Mail.send)? + use std {DeliveryResult}, stored notice_state→derived status? (Delivered=succeeded; skipped now distinct, was merged into failed), host/guest policy +notice_delivery.status leaf only, 3 producers store handle (resend supersedes), pure notice_result removed. Eligibility/device IDs untouched. No examples pre-existed for notice; none stale. Coordinator verified no stale refs, projection parse exit 0 (only pre-existing sequence projected out); no design question.

- [x] **D09 — Rent notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanRent.can, draft/CanRent.md, draft/CanRent.mjs; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: writer 01a106f7-5074-75b0-b216-779ca7635ae9 released. Notice.delivery text unique→delivery(Mail.send), stored state→derived status (all 5 captions kept), policies +delivery.id/.status, 3 producers store handle, pure notice_result removed, resend replaces association on same row. Money/history/charge/venue untouched. Target: delivery schema (rent_reservations.Mail.send), readGrant fields, derived + derives, removal mirrored. Coordinator Q2 repair: normalized 2 nullable-form helper reads to the required-association non-null form (Maintain convention), node re-verified. Projection parse fails only at pre-existing CSV spelling; no stale refs; no design question. J05 now unblocked.

- [x] **D10 — Success notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanSuccess.can, draft/CanSuccess.md; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: writer 01a106f7-51a4-7062-8c42-f6deb119d806 released. Notice.delivery text unique→delivery(Mail.send), stored state→derived status (Delivered=succeeded; skipped now covered, was unrepresentable), policy +delivery.id/.status leaves, lock kept on delivery identity, 2 producers store handle, guarded pure notice_result removed. No examples referenced notice state; none stale. Coordinator verified no stale refs, projection parse exit 0; no design question.

- [x] **J01 — Feedback CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released
  - Owner / files / interfaces: Muse implementation agent; draft/CanFeedback.can, draft/CanFeedback.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: writer 01a106f9-b70a-7153-ac7c-6f61e341c3e5 released. NO-CHANGE: 3 crud declarations (Product/Suggestion/Vote), 5 enabled entries + 4 disabled identities reconcile exactly (Product.create/update, Suggestion.create/update/delete; Product.delete + Vote×3 disabled). Coordinator spot-verified declarations, entry counts, disabled list, Suggestion.create fields/by/when and no-hook state; no files modified, .md untouched. No design question.

- [x] **J02 — Loyalty CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released; D06
  - Owner / files / interfaces: Muse implementation agent; draft/CanLoyalty.can, draft/CanLoyalty.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: writer 01a106fb-c7b6-7ab1-a6e6-a7a4467f9aed released. NO-CHANGE on post-D06 state: 4 crud declarations (Program/Tier/Reward/Account), 7 enabled entries + 5 disabled identities reconcile exactly. Coordinator spot-verified declarations, entries, disabled list, Reward fields/by/when and crudWhen guard; byte-verified Reward fields list after a misread suspicion (file correct, no typo); no files modified, .md untouched. No design question.

- [x] **J03 — Purchase CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released
  - Owner / files / interfaces: Muse implementation agent; draft/CanPurchase.can, draft/CanPurchase.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: writer 01a106fb-c8d9-75e2-9d72-f4b2258101f9 released. NO-CHANGE: 3 crud declarations (Budget/Request/Line, all delete=none), 6 enabled entries; disabled list = 3 explicit deletes + 21 fully-disabled non-crud-model ops (closed-world convention, verified complete). Coordinator spot-verified declarations, entries, full disabled list and model coverage; no files modified, .md untouched. No design question.

- [x] **J04 — Refer CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released
  - Owner / files / interfaces: Muse implementation agent; draft/CanRefer.can, draft/CanRefer.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: writer 01a106ff-5911-7a62-a97f-57f5887f716b released. NO-CHANGE: 1 crud declaration (Program, delete=none), 2 enabled entries + 1 disabled identity reconcile exactly; create/update fields/by/when match; no hooks (qualify is a committed-event handler). Coordinator spot-verified; no files modified, .md untouched. Recorded at H004 catch-up (staging was held).

- [x] **J05 — Rent CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released; D09
  - Owner / files / interfaces: Muse implementation agent; draft/CanRent.can, draft/CanRent.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: writer 01a106ff-5a10-7b61-912f-5c5cda3b8173 released. ONE FIX on post-D09 state: added 2 missing disabled identities (DayCalendar.delete, Desk.delete; both delete=none with existing create/update entries). 4 declarations verified; no source change needed. Coordinator verified entry/disabled reconciliation + node --check OK. Recorded at H004 catch-up (staging was held).

- [x] **J06 — Stock CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released
  - Owner / files / interfaces: Muse implementation agent; draft/CanStock.can, draft/CanStock.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: writer 01a10700-4a34-7c63-aad6-6bad3e9bfea1 released. NO-CHANGE: 2 crud declarations (Item/Threshold, delete=none), 4 enabled entries + 8 disabled identities (closed-world Movement/Projection) reconcile exactly; entry spot-check matches. Coordinator spot-verified; no files modified, .md untouched. Recorded at H004 catch-up (staging was held).

- [x] **A01 — Feedback selector and safe public decision history**
  - Prerequisites: BLOCKED DESIGN: READY inbox message linking feedback-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanFeedback.can, draft/CanFeedback.md, draft/CanFeedback.mjs
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: writer 01a10715-f84a-75c0-839e-02675ad1d0e3 released (H006 READY). Complete C4 witness applied verbatim: Decision/current_decision/contracts/owner-only policy/invariant/3 locks/derive, roadmap+moderate bodies, withdraw_decision + decision_history, both page roots, journey observations + withdrawal table + full 34-step sequence with JS descriptor, .md gap replacement. Coordinator verified every witness section, node --check OK, non-sequence parse exit 0, no public Decision grant, 2 private history sites only. Unexecuted behavior disclosed. No DESIGN/GRAMMAR change; C1/Rent-history/C3/C5 untouched.

- [x] **A02 — Shift complete population progress**
  - Prerequisites: SATISFIED BY USER-OVERRIDE 2026-10-04 (was: READY linking progress-design.md): coordinator acceptance analysis appended to progress-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanShift.can, draft/CanShift.md, draft/CanShift.mjs
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: writer 01a107ad-31a8-7312-84eb-ffc930ff1ceb released (READY-BY-OVERRIDE). EligibilityReview + 5 emitting adapters + review_commitment/review_swap applied verbatim; JS schema/metadata/bodies match; .md states finite-cohort guarantee, retains 100-bounds. 2 stale sync-outcome examples + fixtures removed (no invented each selectors, per doc prohibition). Coordinator verified: added lines touch no forbidden area, only limit=100/1 remain, node --check OK, independent projection parse exit 0 (disclosed: delivery→text, derive label stripped, each= stripped). Unexecuted behavior disclosed.

- [x] **A03 — Volunteer complete population progress**
  - Prerequisites: SATISFIED BY USER-OVERRIDE 2026-10-04 (was: READY linking progress-design.md): coordinator acceptance analysis appended to progress-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanVolunteer.can, draft/CanVolunteer.md, draft/CanVolunteer.mjs
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: writer 01a107b2-7b51-78d3-a418-680db88c10ee released (READY-BY-OVERRIDE). Cancellation subset + all 5 companions + reminder refresh applied verbatim; reschedule/venue_changed bodies untouched (material paths excluded per acceptance). choose() confirmed precedented (DESIGN:249/1100, CanSync/CanEnrich). Coordinator verified: .mjs markers complete, no material-path touches, node --check OK, direct parse identical pre/post (pre-existing 20:134), independent projection parse exit 0 (disclosed: delivery→text, each= stripped). Unexecuted behavior disclosed.

- [x] **A04 — Rent retained-history application**
  - Prerequisites: SATISFIED BY USER-OVERRIDE 2026-10-04 (was: READY linking history-design.md): coordinator-authored history-design.md (499 lines: H1-H4 investigation, G1-G5 gaps, flagged D1-D9, Can + JS witnesses, 14 cases); all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanRent.can, draft/CanRent.md, draft/CanRent.mjs
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: writer 01a107b2-7c80-7ca3-9066-bda29e24855b released (READY-BY-OVERRIDE). Narrowed ResourceEvidence + baseline + 4 fact models + 4 report_*/saved_* derives + report/stamp rewrite + fixtures + 47 fact creates + C8/C10/C11 examples applied. Coordinator verified: 5 marker-only sites all justified (Resource c/u scalar, DayCalendar c/u D5, revise_capacity scalar), no Legacy/Notice/Report-contract touches, future-range ?? now preserved, .md per §2, 87 fact-model .mjs lines, node --check OK, independent projection parse exit 0 (disclosed pre-existing classes: delivery→text, enum-label→scalar, CSV import/review stripped). Specified-journey cases recorded as required outcomes. Unexecuted behavior disclosed.

- [x] **A05 — Mail/Customer dependency and availability application**
  - Prerequisites: SATISFIED BY USER-OVERRIDE 2026-10-04 (was: READY linking dependency-design.md): coordinator-completed W1-W4 witness appended to dependency-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanMail.can, draft/CanMail.md, draft/CanMail.mjs, draft/CanCustomer.can, draft/CanCustomer.md
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: writer 01a107b6-0d0d-79e2-9f1d-44d65bf8c06a released (READY-BY-OVERRIDE). W1 grouped bound import (2→1 lines) + W2 JS counterpart exact; W3 Customer source byte-identical; W4 .md sections added to both files. Coordinator verified: no new-contract spelling in .can (bounds-grep hit was the required witness sentence in .md prose), node --check OK, direct parse fails identically pre/post (pre-existing 27:895 diagnostic, line-shifted only) → no regression. Unexecuted behavior disclosed.

- [x] **A06 — Mail notice retry/reconciliation**
  - Prerequisites: SATISFIED BY USER-OVERRIDE 2026-10-04 (was: READY linking mail-recovery-design.md): coordinator-completed acknowledged_resend witness appended to mail-recovery-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanMail.can, draft/CanMail.md, draft/CanMail.mjs
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: writer 01a107b9-396d-74d0-ba3d-d7b0cdb4d028 released (READY-BY-OVERRIDE). Notice model + Item.notice pointer + 3 frozen-capture conversions + send_another_notice (all 5 requires incl both frozen comparisons) + apply_notice_success applied; JS metadata/handlers match; .md covers all 12 BDD behaviors. Coordinator verified: A05 import preserved, no EmailV1/retry_fee/deployment/available(/reconcile touches, recipient grant byte-identical, node --check OK, direct parse identical pre/post (pre-existing 27:895). Unexecuted behavior disclosed.

- [x] **N01 — Complete Chat draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Chat requirements/contract/source-JS witness
  - Owner / files / interfaces: Codex/Astra (H007 transfer, H009 externally completed); draft/CanChat.md, draft/CanChat.can, draft/CanChat.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: COMPLETED EXTERNALLY (H009): Codex finished + independently reviewed the CanChat triplet; milestones b3c78fc/706c70a/3d41233/13071ec/372def7/82260cf; acceptance in design/COMPLEX-APPS.md + design/complex-apps/completion-verification.json. Not Muse work; never dispatched here.

- [x] **N02 — Complete Creative draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Creative requirements/contract/source-JS witness
  - Owner / files / interfaces: Codex/Astra (H007 transfer, H009 externally completed); draft/CanCreative.md, draft/CanCreative.can, draft/CanCreative.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: COMPLETED EXTERNALLY (H009): Codex finished + independently reviewed the CanCreative triplet; milestones b3c78fc/706c70a/3d41233/13071ec/372def7/82260cf; acceptance in design/COMPLEX-APPS.md + design/complex-apps/completion-verification.json. Not Muse work; never dispatched here.

- [x] **N03 — Complete Gallery draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Gallery requirements/contract/source-JS witness
  - Owner / files / interfaces: Codex/Astra (H007 transfer, H009 externally completed); draft/CanGallery.md, draft/CanGallery.can, draft/CanGallery.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: COMPLETED EXTERNALLY (H009): Codex finished + independently reviewed the CanGallery triplet; milestones b3c78fc/706c70a/3d41233/13071ec/372def7/82260cf; acceptance in design/COMPLEX-APPS.md + design/complex-apps/completion-verification.json. Not Muse work; never dispatched here.

- [x] **N04 — Complete Inbox draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Inbox requirements/contract/source-JS witness
  - Owner / files / interfaces: Codex/Astra (H007 transfer, H009 externally completed); draft/CanInbox.md, draft/CanInbox.can, draft/CanInbox.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: COMPLETED EXTERNALLY (H009): Codex finished + independently reviewed the CanInbox triplet; milestones b3c78fc/706c70a/3d41233/13071ec/372def7/82260cf; acceptance in design/COMPLEX-APPS.md + design/complex-apps/completion-verification.json. Not Muse work; never dispatched here.

- [x] **N05 — Complete Discover draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Discover requirements/contract/source-JS witness
  - Owner / files / interfaces: Codex/Astra (H007 transfer, H009 externally completed); draft/CanDiscover.md, draft/CanDiscover.can, draft/CanDiscover.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: COMPLETED EXTERNALLY (H009): Codex finished + independently reviewed the CanDiscover triplet; milestones b3c78fc/706c70a/3d41233/13071ec/372def7/82260cf; acceptance in design/COMPLEX-APPS.md + design/complex-apps/completion-verification.json. Not Muse work; never dispatched here.

- [x] **N06 — Complete Knowledge draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Knowledge requirements/contract/source-JS witness
  - Owner / files / interfaces: Codex/Astra (H007 transfer, H009 externally completed); draft/CanKnowledge.md, draft/CanKnowledge.can, draft/CanKnowledge.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: COMPLETED EXTERNALLY (H009): Codex finished + independently reviewed the CanKnowledge triplet; milestones b3c78fc/706c70a/3d41233/13071ec/372def7/82260cf; acceptance in design/COMPLEX-APPS.md + design/complex-apps/completion-verification.json. Not Muse work; never dispatched here.

- [x] **N07 — Complete Sync draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Sync requirements/contract/source-JS witness
  - Owner / files / interfaces: Codex/Astra (H007 transfer, H009 externally completed); draft/CanSync.md, draft/CanSync.can, draft/CanSync.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: COMPLETED EXTERNALLY (H009): Codex finished + independently reviewed the CanSync triplet; milestones b3c78fc/706c70a/3d41233/13071ec/372def7/82260cf; acceptance in design/COMPLEX-APPS.md + design/complex-apps/completion-verification.json. Not Muse work; never dispatched here.

- [x] **N08 — Complete Enrich draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Enrich requirements/contract/source-JS witness
  - Owner / files / interfaces: Codex/Astra (H007 transfer, H009 externally completed); draft/CanEnrich.md, draft/CanEnrich.can, draft/CanEnrich.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: COMPLETED EXTERNALLY (H009): Codex finished + independently reviewed the CanEnrich triplet; milestones b3c78fc/706c70a/3d41233/13071ec/372def7/82260cf; acceptance in design/COMPLEX-APPS.md + design/complex-apps/completion-verification.json. Not Muse work; never dispatched here.

- [x] **N09 — Complete Workbench draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Workbench requirements/contract/source-JS witness
  - Owner / files / interfaces: Codex/Astra (H007 transfer, H009 externally completed); draft/CanWorkbench.md, draft/CanWorkbench.can, draft/CanWorkbench.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: COMPLETED EXTERNALLY (H009): Codex finished + independently reviewed the CanWorkbench triplet; milestones b3c78fc/706c70a/3d41233/13071ec/372def7/82260cf; acceptance in design/COMPLEX-APPS.md + design/complex-apps/completion-verification.json. Not Muse work; never dispatched here.

- [x] **N10 — Document extraction extension**
  - Prerequisites: SATISFIED BY USER-OVERRIDE 2026-10-04 (was: READY extraction handoff): coordinator-authored extraction-design.md (796 lines: D1-D9 flagged, Purchase + Expense Can/JS witnesses, 19 cases); J03 released
  - Owner / files / interfaces: Muse implementation agent; draft/CanPurchase.can/.md/.mjs and draft/CanExpense.can/.md/.mjs
  - Changes / traceability: Q1–Q3; implement agreed source-evidence, exact-money and version-bound review journey using existing owners.
  - Acceptance: Reviewed extraction acceptance/failure examples preserve authority and source evidence; corresponding desired JS included.
  - Evidence: writer 01a107b9-db70-7982-9026-59718c5368db released (READY-BY-OVERRIDE). Purchase InvoiceDocument journey (4 scenarios, 8 example blocks, page form+table) + Expense ReceiptExtract journey (transcribe scenario, submit exact-match guard, sequences updated, page form+2 lists) applied; both JS targets match with full-clause disabled entries, no generated CRUD. Coordinator verified: no record_payable/export_payable/decide/withdraw/correct/reimburse body changes, no provider/OCR/capability, no reviewed_version, exact money only; node --check OK both; Purchase parses exit 0 directly; Expense projection parse exit 0 (disclosed pre-existing exclusions: sequence bodies, CSV import/review). Unexecuted behavior disclosed.

- [x] **M01 — Integration, evidence and coherent commits**
  - Prerequisites: M00; per-task released writers; final join after every released implementation task
  - Owner / files / interfaces: Muse coordinator; task-owned source/targets/requirements; this checklist evidence; draft/MIGRATION.md current-status-only changes after reserving it
  - Changes / traceability: Q2/Q4; check changes agree with their released contract, update accurate migration dispositions and commit exact coherent paths early. Do not edit shared DESIGN/GRAMMAR or reinterpret unexecuted examples.
  - Acceptance: Changed target syntax and scoped correspondence pass; required example outcomes preserved; task evidence/commits recorded; unresolved design blockers distinguished from unfinished work. No touching Codex inbox/monitor/design evidence.
  - Evidence: 10/10 D migrations use delivery(Target)+derived status (§8.1 census: all 10 derives present of 21 total); 4/4 changed targets node-OK with uniform §13 lowering (2 coordinator Q2 repairs); 6/6 J slices reconciled (5 no-change + J05 2-line fix); example outcomes preserved/extended per task, none reinterpreted; no stale refs; only justified callbacks remain (Catch diagnostic-only, Mail business transition). 16/16 writers released; exact-path chain dfd9274..a8220e8 (+owner b06d873). A/N distinguished as design-blocked, not unfinished. MIGRATION.md gained one current-status subsection (reserved, no history rewritten).

- [x] **M02 — Release all writers and hand off**
  - Prerequisites: All Muse tasks complete, M01 and DESIGN-CLOSED; or explicit genuinely blocked handoff without marking goal complete
  - Owner / files / interfaces: Muse coordinator; this checklist progress and compact handoff
  - Changes / traceability: Q4; native goal progress/complete state matches actual acceptance, record exact remaining blockers and writer release.
  - Acceptance: Every active implementation agent released; completion evidence delivered to root; Codex review tasks untouched. Unknown runtime correctness is disclosed, not conflated with a missing draft.
  - Evidence: BLOCKED-BRANCH handoff (goal stays active, not marked complete). All 16 writers released (roster 16/16 result_ready); evidence in this checklist; REVIEW/CLOSED untouched. Remaining blockers: A01-A06 + N01-N10 await READY with linked contract/witness; H002 watcher broken (goal-wake fallback). DISCLOSURE: verification is syntax/projection/correspondence-level only — no example executed, no provider/renderer/runtime run; unknown runtime correctness is not claimed. Coordinator suspends to inbox wakes with zero reservations.

- [ ] **C01 — Independent acceptance review and bounded repairs**
  - Prerequisites: Muse handoff and all affected writers released
  - Owner / files / interfaces: Codex; design/muse-migration-20261004/review.md; affected released files
  - Changes / traceability: Review actual diffs/evidence against Q1–Q4 and accepted designs. Send concrete bounded repairs to same Muse session.
  - Acceptance: Material findings resolved and appropriate checks recorded; no repeated broad review without a specific risk/evidence gap.
  - Evidence: pending.

- [ ] **C02 — Final evidence, monitor retirement and cleanup**
  - Prerequisites: C01; no active writer; preserve attached viewing
  - Owner / files / interfaces: Codex; monitor.md/review.md; owned temporary paths recorded in monitor
  - Changes / traceability: Retain compact evidence, remove only owned released resources, retire matching heartbeat after no follow-up remains.
  - Acceptance: Record cleanup/retirement confirmation or precise pending viewer cleanup. Do not stop unrelated sessions or clean shared caches.
  - Evidence: pending.

## Muse progress and acknowledgments

Coordinator-only progress during execution. Record task ID, assigned writer, reserved/released paths, result/evidence and commit; record H-message acknowledgments here.

- M00 complete: coordinator session 01a106e7-49b5-7543-b54f-eb6ad9540769 goal goal-01a106e7-cffe-7b52-a3e5-858eff4a04fe; workspace /Users/vince/Projects/canlang main f5dddbe clean; peer_sessions=[]; approval bypassed/sandbox off/worktree off shared checkout; model route Muse Spark MAX per launch intent, no downgrade, no second coordinator.
- ACK H001 NOTE initial scope: accepted. Ready D01-D10 plus J01/J03/J04/J06 immediate, J02 gated on D06, J05 gated on D09. Blocked A01-A06/N01-N10 await READY with linked contract/witness; no proposal adoption. Max 3 active agents, exact-path commits, writers released at handoff.
- RESERVED D01: draft/CanBook.can, draft/CanBook.md — writer 01a106e9-5e60-7ab0-baaa-f3a392f581ac (D01 CanBook/1) batch 1 active, no .mjs in scope.
- RESERVED D02: draft/CanCatch.can, draft/CanCatch.md — writer 01a106e9-5fa5-7173-b4db-affb9fe22fe7 (D02 CanCatch/2) batch 1 active, no .mjs in scope.
- RESERVED D03: draft/CanDesk.can, draft/CanDesk.md — writer 01a106e9-60b0-7df1-8514-c73fee43624e (D03 CanDesk/3) batch 1 active, no .mjs in scope.
- QUEUED: ready agent queue EXHAUSTED (D01-D10, J01-J06 all verified). Remaining: M01/M02 + design-blocked A01-A06/N01-N10 awaiting READY.
- DONE J04: writer 01a106ff-5911-7a62-a97f-57f5887f716b RELEASED draft/CanRefer.can, draft/CanRefer.mjs (no changes).
- DONE J05: writer 01a106ff-5a10-7b61-912f-5c5cda3b8173 RELEASED draft/CanRent.can, draft/CanRent.mjs (2-line disabled-list fix).
- DONE J06: writer 01a10700-4a34-7c63-aad6-6bad3e9bfea1 RELEASED draft/CanStock.can, draft/CanStock.mjs (no changes).
- ACK H004 READY ownership returned: accepted. Codex b06d873 confirmed as child of 0a79ac7; staging/commit ownership resumed. Production prompts are not Muse tasks; no new sessions; no reservations/design adopted. Staging inbox.md + monitor.md UNCHANGED per H004 authorization (both remain Codex-authored/read-only).
- LIMITATION H002 watcher: wait-for-inbox.py crashes immediately (select.kqueue context-manager TypeError); Codex-owned, not patched by Muse. Used 5-min goal wakes + inbox re-reads instead; no busy polling. H004 latency unaffected in practice.
- RESERVED M01: draft/MIGRATION.md current-status-only subsection — coordinator, no writer. No other party editing it (tree clean at reservation).
- DONE M01: integration evidenced (§8.1/§13 census, 4/4 node-OK, example preservation, A/N distinguished blocked). RELEASED M01 MIGRATION.md.
- DONE M02: BLOCKED-BRANCH handoff recorded. Zero active writers, zero reservations. A01-A06/N01-N10 deferred to READY; REVIEW/CLOSED untouched for Codex. Runtime-correctness unknown disclosed. Goal stays active for inbox wakes.
- DONE A01: writer 01a10715-f84a-75c0-839e-02675ad1d0e3 RELEASED draft/CanFeedback.can, draft/CanFeedback.md, draft/CanFeedback.mjs. Inbox re-read: H001-H006, no newer IDs. Staged per H006 list only (trio + tasks + unmodified design/evidence/review/inbox/monitor).
- ACK H007 RELEASE-REQUEST complex-app transfer: accepted. User assigned CanChat/CanCreative/CanGallery/CanInbox/CanDiscover/CanKnowledge/CanSync/CanEnrich/CanWorkbench drafts to Codex/Astra. Confirmed zero active writers (17/17 result_ready). N10 + A02-A06 retain prerequisites. No new sessions; git ownership stays with Muse.
- RELEASED H007: N01-N09 tasks + draft/Can{Chat,Creative,Gallery,Inbox,Discover,Knowledge,Sync,Enrich,Workbench}.{md,can,mjs} paths to Codex/Astra. Preserved unticked/unfinished with external owner noted; never dispatched from here, no READY received. Not completion.
- ACK H008 RELEASE-REQUEST git ownership for Codex complex-app commits: accepted. Zero active writers; no pending Muse commit (all owned files clean; DESIGN/GRAMMAR/CRM/complex drafts are others'). No worker stages/commits (standing rule). No pull/rebase.
- RELEASED H008: git-index and commit ownership. Coordinator Git mutations HELD until later explicit return. App-file reservations unaffected (none active).
- ACK H009 COMPLETE/GIT-RETURN: accepted. N01-N09 recorded completed externally (milestones + COMPLEX-APPS.md + completion-verification.json verified present; log confirms). No redispatch, no CanDecide work, no proposal approvals. Git ownership RESUMED; --only exact-path discipline; no reset/rebase; H009 inbox/monitor notes staged unchanged (Codex-authored).
- ACK H010 RELEASE-REQUEST user-requested commit/origin-integration/push: accepted. All 17/17 writers result_ready, zero active, zero reservations; no pending Muse commit (owned CanFeedback trio + tasks.md verified clean; HEAD 74cf3cb Codex-authored). No pull/rebase; no new session.
- RELEASED H010: git-index, commit and checkout integration ownership. ALL Git mutations AND shared-checkout writes HELD until H011 returns ownership; no work launched in this checkout during Codex main-branch merge. A02-A06 + N10 still await READY.
- ACK H011 CONDITIONAL GIT-RETURN: condition VERIFIED (ls-remote origin/main b1aa78e == local HEAD; H011 commit 04dd27a ancestor of remote main; no MERGE_HEAD/rebase). Hold LIFTED; git/checkout ownership RESUMED for saved authorized migration scope only, exact-path commits, no reset/rebase/pull, production worktrees preserved. Design gates remain in force; A02-A06 + N10 still await READY. monitor.md working-tree edit is Codex-authored, untouched.
- USER-OVERRIDE 2026-10-04 (gridlock breaker; user selected 'I design + implement'): coordinator completes missing design-stage work then implements A02-A06 + N10 without inbox READY. Design reservations (coordinator-owned exact paths): append witness to mail-recovery-design.md (A06), append witness to dependency-design.md (A05), new history-design.md (A04), new extraction-design.md (N10), coordinator review of progress-design.md (A02/A03). Preserved: no DESIGN/GRAMMAR/shared-contract changes; no rejected-JEV retry/rephrase; max 3 active; exact-path commits; Codex C01/C02 review after. Any arriving inbox READY supersedes coordinator candidates for its task.
- DISPATCH design batch 1 (3/3 slots): A06-witness writer, A05-witness writer, A04-design writer (exact design paths above). Queued: N10 design, A02/A03 coordinator review, then A02-A06/N10 implementation writers (A05 before A06: shared CanMail files).
- DONE coordinator review A02/A03: acceptance analysis appended to progress-design.md (user-authorized; Codex review pending). ACCEPTED: Shift witness verbatim; Volunteer cancellation subset + 5 companions + reminder refresh. NOT accepted: DESIGN/GRAMMAR edits, material reschedule/venue_changed (negative BDD stands). JEV gap disclosed (2/3 advisory, request 2 not retried). Drift check clean. A02/A03 inputs READY-BY-OVERRIDE; implementation writers queued behind design batch 1 releases.
- DONE design A06: writer 01a107ab-3794-77b2-b865-983591efa71f RELEASED mail-recovery-design.md (append-only 201+, JEV disagreement investigated to acknowledged_resend, delivery-identity rule, Can + desired-JS witnesses, 12 BDD scenarios; scope discipline verified, nothing applied to drafts).
- DONE design A05: writer 01a107ab-3982-7ef2-9bf1-80435fa77d6f RELEASED dependency-design.md (append-only 89+, W1 grouped bound import + W2 JS counterpart per CanRent precedent, W3 honest no-reduction closure, W4 BDD; .md replacement text left to application). A05/A06 inputs READY-BY-OVERRIDE.
- DISPATCH batch 2 (slots freed x2): N10-design writer (new extraction-design.md), A02 implementation writer (CanShift triplet). A04-design still running. Queued: A03/A04/A05/A06/N10 implementation (A05 before A06).
- DONE A02: writer 01a107ad-31a8-7312-84eb-ffc930ff1ceb RELEASED draft/CanShift.can, draft/CanShift.md, draft/CanShift.mjs. Task ticked complete (see A02 evidence).
- DONE design A04: writer 01a107ab-3b05-7580-a454-935716911f8a RELEASED history-design.md (new 499-line file only; git untouched). Verified: H1-H4/G1-G5 investigation, D1-D9 flagged ([proposal]/[new]), Can + JS witnesses, 14 cases with honest isolated/journey split, JEV advice disclosed without re-vote, scaffold parse + node --check exit 0 claimed on wrappers. A04 input READY-BY-OVERRIDE.
- DISPATCH batch 3 (slots freed x2): A03 implementation writer (CanVolunteer triplet), A04 implementation writer (CanRent triplet). N10-design still running. Queued: A05, A06, N10 implementation (A05 before A06).
- DONE design N10: writer 01a107ad-309c-7012-a535-1278de5081bb RELEASED extraction-design.md (new 796-line file only; git untouched). Verified: D1-D9 flagged with alternatives + line-cited precedents (D1: manual transcription v1, no provider, seam preserved), Purchase + Expense Can/JS witnesses, 19 required cases, no-JEV rationale disclosed, snippet node --check claimed. N10 input READY-BY-OVERRIDE.
- DISPATCH batch 4 (slot freed x1): A05 implementation writer (CanMail triplet + CanCustomer.can/.md). A03/A04 still running. Queued: A06 (after A05 release), N10 implementation.
- DONE A05: writer 01a107b6-0d0d-79e2-9f1d-44d65bf8c06a RELEASED draft/CanMail.can, draft/CanMail.md, draft/CanMail.mjs, draft/CanCustomer.md (CanCustomer.can untouched). Task ticked complete (see A05 evidence).
- DISPATCH batch 5 (slot freed x1): A06 implementation writer (CanMail triplet; A05 released, ordering satisfied). A03/A04 still running. Queued: N10 implementation.
- DONE A03: writer 01a107b2-7b51-78d3-a418-680db88c10ee RELEASED draft/CanVolunteer.can, draft/CanVolunteer.md, draft/CanVolunteer.mjs. Task ticked complete (see A03 evidence).
- DISPATCH batch 6 (slot freed x1): N10 implementation writer (Purchase + Expense triplets). A04/A06 running. Queue empty; final integration + handoff after releases.
- DONE A04: writer 01a107b2-7c80-7ca3-9066-bda29e24855b RELEASED draft/CanRent.can, draft/CanRent.md, draft/CanRent.mjs. Task ticked complete (see A04 evidence). 5/6 gated tasks done; A06 + N10 running.
- DONE A06: writer 01a107b9-396d-74d0-ba3d-d7b0cdb4d028 RELEASED draft/CanMail.can, draft/CanMail.md, draft/CanMail.mjs. Task ticked complete (see A06 evidence). All A-tasks done; N10 running (last writer).
- DONE N10: writer 01a107b9-db70-7982-9026-59718c5368db RELEASED all 6 Purchase/Expense files. Task ticked complete (see N10 evidence). 6/6 gated tasks done; zero writers active.
- HANDOFF COMPLETE 2026-10-04: every Muse-owned task evidenced (M00/M01/M02 + D01-D10 + J01-J06 + A01-A06 + N10; N01-N09 completed externally per H009). Roster 27/27 result_ready, zero active, zero reservations. Integration: 7/7 A/N targets node --check OK; override commits touched only draft/Can* + tasks/progress/mail-recovery/dependency/history/extraction design files (no DESIGN/GRAMMAR/REQUIREMENTS/compiler); inbox ends at H011 with no superseding READY. DISCLOSURE: verification is syntax/projection/correspondence-level only; coordinator-authored A02-A06/N10 inputs await Codex C01/C02 independent review. Writers released; handoff ready.
- ACK H012 RELEASE-REQUEST scheduled origin synchronization: accepted. Confirmed 27/27 writers result_ready, zero active, zero reservations; handoff commit 17544fe is the final Muse commit, nothing pending.
- RELEASED H012: git-index, commit and checkout integration ownership. ALL Git/shared-checkout mutations HELD until H013. No app changes, workers, or sessions. C01/C02 still Codex-pending; no runtime correctness claimed.
- ACK H013 CONDITIONAL GIT-RETURN: condition VERIFIED (H013 commit a14cb32 == local HEAD and ancestor of origin/main 71394c0; no MERGE_HEAD/rebase). H012 hold LIFTED; ownership returned with completed handoff retained, C01/C02 still pending, no new work authorized.
- ACK H014 RELEASE-REQUEST 16:56 UTC sync: accepted. 27/27 writers result_ready, zero active, zero reservations (verified this session, no spawns since); handoff commit 17544fe + release records complete, nothing pending.
- RELEASED H014: git-index, commit and checkout integration ownership. ALL mutations HELD until H015 publication. No new work, workers, or sessions. Completed handoff + worktrees preserved.
- ACK H015 CONDITIONAL GIT-RETURN: condition VERIFIED (H015 commit 082ba1b contains H015 and is ancestor of origin/main 2f16cf3; no MERGE_HEAD/rebase, no index.lock). H014 hold LIFTED; ownership returned with completed handoff retained, C01/C02 still pending, no new work authorized.
- ACK H016 RELEASE-REQUEST 17:46 UTC sync: accepted. Fresh roster check: 27/27 writers result_ready, zero active, zero reservations; handoff + release records complete, nothing pending. No coordinator-role change (per H016, role question stays with the user).
- RELEASED H016: git-index, commit and checkout integration ownership. ALL mutations HELD until H017 publication. No new work, workers, sessions, or role decisions.
- ACK H017 CONDITIONAL GIT-RETURN: condition VERIFIED (H017 commit 58a7366 contains H017, ancestor of merge d8f3e3e == local HEAD, ancestor of origin/main ed9da98; no MERGE_HEAD/rebase, no index.lock). H016 hold LIFTED; ownership returned with completed handoff retained, C01/C02 still pending, no new work authorized.
- ACK H018 RELEASE-REQUEST 18:11 UTC sync: accepted. Fresh roster check: 27/27 writers result_ready, zero active, zero reservations; handoff + release records complete, nothing pending.
- RELEASED H018: git-index, commit and checkout integration ownership. ALL mutations HELD until H019 publication. No new work, workers, sessions, or role changes.
- ACK H019 CONDITIONAL GIT-RETURN: condition VERIFIED (H019 commit b9f643a contains H019, ancestor of merge 6ac833c == local HEAD, ancestor of origin/main 099d6c6; no MERGE_HEAD/rebase, no index.lock). H018 hold LIFTED; ownership returned with completed handoff retained, C01/C02 still pending, no new work authorized.
- ACK H020 RELEASE-REQUEST 18:36 UTC sync: accepted. Fresh roster check: 27/27 writers result_ready, zero active, zero reservations; handoff + release records complete, nothing pending.
- RELEASED H020: git-index, commit and checkout integration ownership. ALL mutations HELD until H021 publication. No new work, workers, sessions, or role changes.
- ACK H021 CONDITIONAL GIT-RETURN: condition VERIFIED (H021 commit cee4a81 == local HEAD, ancestor of origin/main c122d71; no MERGE_HEAD/rebase, no index.lock). H020 hold LIFTED; ownership returned with completed handoff retained, C01/C02 still pending, no new work authorized.
- ACK H022 RELEASE-REQUEST 19:01 UTC sync: accepted. Fresh roster check: 27/27 writers result_ready, zero active, zero reservations; handoff + release records complete, nothing pending.
- RELEASED H022: git-index, commit and checkout integration ownership. ALL mutations HELD until H023 publication. No new work, workers, sessions, or role changes.
- ACK H023 CONDITIONAL GIT-RETURN: condition VERIFIED (H023 commit 76beb09, ancestor of origin/main 2b3fd82; no MERGE_HEAD/rebase, no index.lock). H022 hold LIFTED; ownership returned with completed handoff retained, C01/C02 still pending, no new work authorized.
- ACK H024 RELEASE-REQUEST 19:26 UTC sync: accepted. Fresh roster check: 27/27 writers result_ready, zero active, zero reservations; handoff + release records complete, nothing pending.
- RELEASED H024: git-index, commit and checkout integration ownership. ALL mutations HELD until H025 publication. No new work, workers, sessions, or role changes.
- ACK H025 CONDITIONAL GIT-RETURN: condition VERIFIED (H025 commit 175be65 == local HEAD, ancestor of origin/main 6a3adc0; no MERGE_HEAD/rebase, no index.lock). H024 hold LIFTED; ownership returned with completed handoff retained, C01/C02 still pending, no new work authorized.
- ACK H026 RELEASE-REQUEST 19:51 UTC sync: accepted. Fresh roster check: 27/27 writers result_ready, zero active, zero reservations; handoff + release records complete, nothing pending.
- RELEASED H026: git-index, commit and checkout integration ownership. ALL mutations HELD until H027 publication. No new work, workers, sessions, or role changes.
- ACK H027 CONDITIONAL GIT-RETURN: condition VERIFIED (H027 commit 6fa2fab == local HEAD, ancestor of origin/main 544e813; no MERGE_HEAD/rebase, no index.lock). H026 hold LIFTED; ownership returned with completed handoff retained, C01/C02 still pending, no new work authorized.
- ACK H028 RELEASE-REQUEST 20:16 UTC sync: accepted. Fresh roster check: 27/27 writers result_ready, zero active, zero reservations; handoff + release records complete, nothing pending.
- RELEASED H028: git-index, commit and checkout integration ownership. ALL mutations HELD until H029 publication. No new work, workers, sessions, or role changes.
- ACK H029 CONDITIONAL GIT-RETURN: condition VERIFIED (H029 commit f8771d5 == local HEAD, ancestor of origin/main a4b52d5; no MERGE_HEAD/rebase, no index.lock). H028 hold LIFTED; ownership returned with completed handoff retained, C01/C02 still pending, no new work authorized.
- ACK H030 RELEASE-REQUEST 20:41 UTC sync: accepted. Fresh roster check: 27/27 writers result_ready, zero active, zero reservations; handoff + release records complete, nothing pending.
- RELEASED H030: git-index, commit and checkout integration ownership. ALL mutations HELD until H031 publication. No new work, workers, sessions, or role changes.
- ACK H005 NOTE watcher repaired: accepted. contextlib.closing fix noted; H002 command reusable when ready work next exhausts (not now — A01 active). No TUI-push claim.
- ACK H006 READY A01 accepted: complete C4 feedback-design.md (457 lines) + review.md limits read in full. Scope: Decision/current_decision/contracts/policy/invariant/locks/derive, roadmap/moderate bodies, withdraw_decision/decision_history, both page roots, full target mirror, journey observations + withdrawal table + decision_history sequence, 15-row required-cases table. No DESIGN/GRAMMAR/runtime work. C1/Rent-history/C3/C5 remain unadopted.
- RESERVED A01: draft/CanFeedback.can, draft/CanFeedback.md, draft/CanFeedback.mjs — writer 01a10715-f84a-75c0-839e-02675ad1d0e3 (A01 Feedback/17) active. J01 released; no pending Feedback edits at handoff (verified clean).
- DONE D09: writer 01a106f7-5074-75b0-b216-779ca7635ae9 RELEASED draft/CanRent.can, draft/CanRent.md, draft/CanRent.mjs (incl coordinator Q2 repair). Inbox re-read: H001+H002+H003.
- DONE J02: writer 01a106fb-c7b6-7ab1-a6e6-a7a4467f9aed RELEASED draft/CanLoyalty.can, draft/CanLoyalty.mjs (no changes). No new inbox IDs at verification.
- DONE J03: writer 01a106fb-c8d9-75e2-9d72-f4b2258101f9 RELEASED draft/CanPurchase.can, draft/CanPurchase.mjs (no changes).
- ACK H003 RELEASE-REQUEST git-index/commit handoff: accepted. Scope is index/commit ownership ONLY; app-file ownership retained; no new coordinator; production prompts under implementation/ are not Muse tasks and remain untouched. No agent stages/commits (standing rule). Affected tasks: none (all writers already released at handoff point).
- RELEASED H003: git-index and commit ownership. Coordinator staging/commits HELD until H004. Checklist frozen clean at release commit; implementation continues via reserved agents.
- RESERVED J04: draft/CanRefer.can, draft/CanRefer.mjs (+ .md only for actual requirement correction) — writer 01a106ff-5911-7a62-a97f-57f5887f716b (J04 Refer/14) batch 8 active.
- RESERVED J05: draft/CanRent.can, draft/CanRent.mjs (+ .md only for actual requirement correction) — writer 01a106ff-5a10-7b61-912f-5c5cda3b8173 (J05 Rent/15) batch 8 active. Reviews post-D09 state.
- DONE J01: writer 01a106f9-b70a-7153-ac7c-6f61e341c3e5 RELEASED draft/CanFeedback.can, draft/CanFeedback.mjs (no changes; no files modified). Inbox re-read: H001+H002 only.
- DONE D07: writer 01a106f4-0f69-72b2-8ce3-c7987750d3ff RELEASED draft/CanMaintain.can, draft/CanMaintain.md, draft/CanMaintain.mjs. No new inbox IDs.
- RESERVED J02: draft/CanLoyalty.can, draft/CanLoyalty.mjs (+ .md only for actual requirement correction) — writer 01a106fb-c7b6-7ab1-a6e6-a7a4467f9aed (J02 Loyalty/12) batch 7 active. Reviews post-D06 state.
- RESERVED J03: draft/CanPurchase.can, draft/CanPurchase.mjs (+ .md only for actual requirement correction) — writer 01a106fb-c8d9-75e2-9d72-f4b2258101f9 (J03 Purchase/13) batch 7 active.
- DONE D10: writer 01a106f7-51a4-7062-8c42-f6deb119d806 RELEASED draft/CanSuccess.can, draft/CanSuccess.md. Inbox re-read: H001+H002 only.
- RESERVED J01: draft/CanFeedback.can, draft/CanFeedback.mjs (+ .md only for actual requirement correction) — writer 01a106f9-b70a-7153-ac7c-6f61e341c3e5 (J01 Feedback/11) batch 6 active. Note: correspondence only; selector/history design is A01-blocked, do not touch.
- DONE D08: writer 01a106f4-105e-79b1-a7d5-325dfb6472d1 RELEASED draft/CanReception.can, draft/CanReception.md. Inbox re-read: H001+H002 only.
- RESERVED D10: draft/CanSuccess.can, draft/CanSuccess.md — writer 01a106f7-51a4-7062-8c42-f6deb119d806 (D10 CanSuccess/10) batch 5 active, no .mjs in scope.
- DONE D06: writer 01a106f0-8288-7af3-9d03-2340cfca77f1 RELEASED draft/CanLoyalty.can, draft/CanLoyalty.md, draft/CanLoyalty.mjs. Inbox re-read: H001+H002 only.
- RESERVED D09: draft/CanRent.can, draft/CanRent.md, draft/CanRent.mjs — writer 01a106f7-5074-75b0-b216-779ca7635ae9 (D09 CanRent/9) batch 5 active. J05 gated on D09 release. Note: notice callback only; history/capture, money, charge/refund work excluded.
- DONE D04: writer 01a106ee-0d5e-78e0-82aa-3296498e1fad RELEASED draft/CanEvent.can, draft/CanEvent.md. Inbox re-read after results: H001+H002 only.
- DONE D05: writer 01a106ee-0e65-7670-9327-063030f84315 RELEASED draft/CanHire.can, draft/CanHire.md, draft/CanHire.mjs. No new inbox IDs.
- RESERVED D07: draft/CanMaintain.can, draft/CanMaintain.md, draft/CanMaintain.mjs — writer 01a106f4-0f69-72b2-8ce3-c7987750d3ff (D07 CanMaintain/7) batch 4 active.
- RESERVED D08: draft/CanReception.can, draft/CanReception.md — writer 01a106f4-105e-79b1-a7d5-325dfb6472d1 (D08 CanReception/8) batch 4 active, no .mjs in scope.
- ACK H002 NOTE file waiting: accepted. External push unavailable (external_agent_ingress_closed); file protocol authoritative. One-shot kqueue watcher reserved for use only when ready queue is exhausted and intake still open; no watcher running while ready work active. Affected tasks: none.
- DONE D01: writer 01a106e9-5e60-7ab0-baaa-f3a392f581ac RELEASED draft/CanBook.can, draft/CanBook.md. Inbox re-read after result: H001+H002 only, no new IDs.
- DONE D02: writer 01a106e9-5fa5-7173-b4db-affb9fe22fe7 RELEASED draft/CanCatch.can, draft/CanCatch.md. No new inbox IDs.
- DONE D03: writer 01a106e9-60b0-7df1-8514-c73fee43624e RELEASED draft/CanDesk.can, draft/CanDesk.md. Inbox re-read: H001+H002 only. Untracked feedback-design.md/progress-design.md observed but no READY: NOT adopted, awaiting inbox authorization.
- REPAIR D01 (coordinator, post-release): added use std {DeliveryResult} to draft/CanBook.can; re-verified.
- RESERVED D06: draft/CanLoyalty.can, draft/CanLoyalty.md, draft/CanLoyalty.mjs — writer 01a106f0-8288-7af3-9d03-2340cfca77f1 (D06 CanLoyalty/6) batch 3 active. J02 gated on D06 release.
- RESERVED D04: draft/CanEvent.can, draft/CanEvent.md — writer 01a106ee-0d5e-78e0-82aa-3296498e1fad (D04 CanEvent/4) batch 2 active, no .mjs in scope. Note: Billing.charge association exists; scope is notice callback only.
- RESERVED D05: draft/CanHire.can, draft/CanHire.md, draft/CanHire.mjs — writer 01a106ee-0e65-7670-9327-063030f84315 (D05 CanHire/5) batch 2 active.
