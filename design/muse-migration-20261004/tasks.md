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

- [ ] **D06 — Loyalty notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanLoyalty.can, draft/CanLoyalty.md, draft/CanLoyalty.mjs; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: pending.

- [ ] **D07 — Maintain notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanMaintain.can, draft/CanMaintain.md, draft/CanMaintain.mjs; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: pending.

- [ ] **D08 — Reception notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanReception.can, draft/CanReception.md; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: pending.

- [ ] **D09 — Rent notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanRent.can, draft/CanRent.md, draft/CanRent.mjs; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: pending.

- [ ] **D10 — Success notification delivery association**
  - Prerequisites: M00; exclusive ownership of this pair
  - Owner / files / interfaces: Muse implementation agent; draft/CanSuccess.can, draft/CanSuccess.md; DESIGN §8.1 (read-only)
  - Changes / traceability: Q1/Q2; apply the settled association to the inspected notification/notice callback only. Preserve business guards, immutable inputs, diagnostics, audience-safe id/status/result/error leaves and meaningful examples. Do not wholesale-convert all raw IDs.
  - Acceptance: No redundant pure receipt-status mirror remains for the selected notice. Source/existing target, authorized projection/UI and examples agree; focused checks and compact diff evidence. If the mapping needs a new rule, report the exact design question and work on another ready task.
  - Evidence: pending.

- [ ] **J01 — Feedback CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released
  - Owner / files / interfaces: Muse implementation agent; draft/CanFeedback.can, draft/CanFeedback.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: pending.

- [ ] **J02 — Loyalty CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released; D06
  - Owner / files / interfaces: Muse implementation agent; draft/CanLoyalty.can, draft/CanLoyalty.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: pending.

- [ ] **J03 — Purchase CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released
  - Owner / files / interfaces: Muse implementation agent; draft/CanPurchase.can, draft/CanPurchase.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: pending.

- [ ] **J04 — Refer CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released
  - Owner / files / interfaces: Muse implementation agent; draft/CanRefer.can, draft/CanRefer.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: pending.

- [ ] **J05 — Rent CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released; D09
  - Owner / files / interfaces: Muse implementation agent; draft/CanRent.can, draft/CanRent.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: pending.

- [ ] **J06 — Stock CRUD/hook source-target correspondence**
  - Prerequisites: M00; source pair writer released
  - Owner / files / interfaces: Muse implementation agent; draft/CanStock.can, draft/CanStock.mjs; companion .md only for actual requirement correction
  - Changes / traceability: Q2; finish the unreviewed CRUD/hook slice using settled rules. Compare canonical enabled/disabled entries, fields, guards, qualified roles, hook versions/order and actual bodies. Correct only unambiguous divergence.
  - Acceptance: Compact declaration/callback inventory with exact mismatch fixes or no-change evidence. New semantic questions are returned to Astra. No needless repeat of unrelated policy/body reviews.
  - Evidence: pending.

- [ ] **A01 — Feedback selector and safe public decision history**
  - Prerequisites: BLOCKED DESIGN: READY inbox message linking feedback-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanFeedback.can, draft/CanFeedback.md, draft/CanFeedback.mjs
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: pending.

- [ ] **A02 — Shift complete population progress**
  - Prerequisites: BLOCKED DESIGN: READY inbox message linking progress-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanShift.can, draft/CanShift.md, draft/CanShift.mjs
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: pending.

- [ ] **A03 — Volunteer complete population progress**
  - Prerequisites: BLOCKED DESIGN: READY inbox message linking progress-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanVolunteer.can, draft/CanVolunteer.md, draft/CanVolunteer.mjs
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: pending.

- [ ] **A04 — Rent retained-history application**
  - Prerequisites: BLOCKED DESIGN: READY inbox message linking history-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanRent.can, draft/CanRent.md, draft/CanRent.mjs
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: pending.

- [ ] **A05 — Mail/Customer dependency and availability application**
  - Prerequisites: BLOCKED DESIGN: READY inbox message linking dependency-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanMail.can, draft/CanMail.md, draft/CanMail.mjs, draft/CanCustomer.can, draft/CanCustomer.md
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: pending.

- [ ] **A06 — Mail notice retry/reconciliation**
  - Prerequisites: BLOCKED DESIGN: READY inbox message linking mail-recovery-design.md; all overlapping writers released
  - Owner / files / interfaces: Muse implementation agent; draft/CanMail.can, draft/CanMail.md, draft/CanMail.mjs
  - Changes / traceability: Q1–Q3; apply the complete accepted design witness and its explicitly listed cases. The document filename is a destination, not a claim a design exists.
  - Acceptance: Agreed behavior, permissions and exact source/JS expectations match; focused checks; no unstated policy or invented dependency.
  - Evidence: pending.

- [ ] **N01 — Complete Chat draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Chat requirements/contract/source-JS witness
  - Owner / files / interfaces: Muse implementation agent; draft/CanChat.md, draft/CanChat.can, draft/CanChat.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: pending.

- [ ] **N02 — Complete Creative draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Creative requirements/contract/source-JS witness
  - Owner / files / interfaces: Muse implementation agent; draft/CanCreative.md, draft/CanCreative.can, draft/CanCreative.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: pending.

- [ ] **N03 — Complete Gallery draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Gallery requirements/contract/source-JS witness
  - Owner / files / interfaces: Muse implementation agent; draft/CanGallery.md, draft/CanGallery.can, draft/CanGallery.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: pending.

- [ ] **N04 — Complete Inbox draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Inbox requirements/contract/source-JS witness
  - Owner / files / interfaces: Muse implementation agent; draft/CanInbox.md, draft/CanInbox.can, draft/CanInbox.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: pending.

- [ ] **N05 — Complete Discover draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Discover requirements/contract/source-JS witness
  - Owner / files / interfaces: Muse implementation agent; draft/CanDiscover.md, draft/CanDiscover.can, draft/CanDiscover.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: pending.

- [ ] **N06 — Complete Knowledge draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Knowledge requirements/contract/source-JS witness
  - Owner / files / interfaces: Muse implementation agent; draft/CanKnowledge.md, draft/CanKnowledge.can, draft/CanKnowledge.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: pending.

- [ ] **N07 — Complete Sync draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Sync requirements/contract/source-JS witness
  - Owner / files / interfaces: Muse implementation agent; draft/CanSync.md, draft/CanSync.can, draft/CanSync.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: pending.

- [ ] **N08 — Complete Enrich draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Enrich requirements/contract/source-JS witness
  - Owner / files / interfaces: Muse implementation agent; draft/CanEnrich.md, draft/CanEnrich.can, draft/CanEnrich.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: pending.

- [ ] **N09 — Complete Workbench draft from its design handoff**
  - Prerequisites: BLOCKED DESIGN: READY inbox message with complete Workbench requirements/contract/source-JS witness
  - Owner / files / interfaces: Muse implementation agent; draft/CanWorkbench.md, draft/CanWorkbench.can, draft/CanWorkbench.mjs
  - Changes / traceability: Q1–Q3; expand settled design into a complete company workflow draft with UI, permissions, translations and meaningful success/failure/recovery examples. design/AI-AND-SERVICE-DRAFTS.md is background only, not sufficient implementation input.
  - Acceptance: Complete scoped journey and consistent proposed JS imports; no compiler/library/infrastructure implementation. New contracts must be explicitly released before use.
  - Evidence: pending.

- [ ] **N10 — Document extraction extension**
  - Prerequisites: BLOCKED DESIGN: READY extraction handoff; J03 and any relevant writer release
  - Owner / files / interfaces: Muse implementation agent; draft/CanPurchase.can/.md/.mjs and draft/CanExpense.can/.md/.mjs
  - Changes / traceability: Q1–Q3; implement agreed source-evidence, exact-money and version-bound review journey using existing owners.
  - Acceptance: Reviewed extraction acceptance/failure examples preserve authority and source evidence; corresponding desired JS included.
  - Evidence: pending.

- [ ] **M01 — Integration, evidence and coherent commits**
  - Prerequisites: M00; per-task released writers; final join after every released implementation task
  - Owner / files / interfaces: Muse coordinator; task-owned source/targets/requirements; this checklist evidence; draft/MIGRATION.md current-status-only changes after reserving it
  - Changes / traceability: Q2/Q4; check changes agree with their released contract, update accurate migration dispositions and commit exact coherent paths early. Do not edit shared DESIGN/GRAMMAR or reinterpret unexecuted examples.
  - Acceptance: Changed target syntax and scoped correspondence pass; required example outcomes preserved; task evidence/commits recorded; unresolved design blockers distinguished from unfinished work. No touching Codex inbox/monitor/design evidence.
  - Evidence: pending.

- [ ] **M02 — Release all writers and hand off**
  - Prerequisites: All Muse tasks complete, M01 and DESIGN-CLOSED; or explicit genuinely blocked handoff without marking goal complete
  - Owner / files / interfaces: Muse coordinator; this checklist progress and compact handoff
  - Changes / traceability: Q4; native goal progress/complete state matches actual acceptance, record exact remaining blockers and writer release.
  - Acceptance: Every active implementation agent released; completion evidence delivered to root; Codex review tasks untouched. Unknown runtime correctness is disclosed, not conflated with a missing draft.
  - Evidence: pending.

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
- QUEUED ready disjoint: D09/D10, J01/J03/J04/J06. J02 waits D06 release; J05 waits D09 release.
- DONE D04: writer 01a106ee-0d5e-78e0-82aa-3296498e1fad RELEASED draft/CanEvent.can, draft/CanEvent.md. Inbox re-read after results: H001+H002 only.
- DONE D05: writer 01a106ee-0e65-7670-9327-063030f84315 RELEASED draft/CanHire.can, draft/CanHire.md, draft/CanHire.mjs. No new inbox IDs.
- RESERVED D07: draft/CanMaintain.can, draft/CanMaintain.md, draft/CanMaintain.mjs — writer pending spawn batch 4.
- RESERVED D08: draft/CanReception.can, draft/CanReception.md — writer pending spawn batch 4, no .mjs in scope.
- ACK H002 NOTE file waiting: accepted. External push unavailable (external_agent_ingress_closed); file protocol authoritative. One-shot kqueue watcher reserved for use only when ready queue is exhausted and intake still open; no watcher running while ready work active. Affected tasks: none.
- DONE D01: writer 01a106e9-5e60-7ab0-baaa-f3a392f581ac RELEASED draft/CanBook.can, draft/CanBook.md. Inbox re-read after result: H001+H002 only, no new IDs.
- DONE D02: writer 01a106e9-5fa5-7173-b4db-affb9fe22fe7 RELEASED draft/CanCatch.can, draft/CanCatch.md. No new inbox IDs.
- DONE D03: writer 01a106e9-60b0-7df1-8514-c73fee43624e RELEASED draft/CanDesk.can, draft/CanDesk.md. Inbox re-read: H001+H002 only. Untracked feedback-design.md/progress-design.md observed but no READY: NOT adopted, awaiting inbox authorization.
- REPAIR D01 (coordinator, post-release): added use std {DeliveryResult} to draft/CanBook.can; re-verified.
- RESERVED D06: draft/CanLoyalty.can, draft/CanLoyalty.md, draft/CanLoyalty.mjs — writer 01a106f0-8288-7af3-9d03-2340cfca77f1 (D06 CanLoyalty/6) batch 3 active. J02 gated on D06 release.
- RESERVED D04: draft/CanEvent.can, draft/CanEvent.md — writer 01a106ee-0d5e-78e0-82aa-3296498e1fad (D04 CanEvent/4) batch 2 active, no .mjs in scope. Note: Billing.charge association exists; scope is notice callback only.
- RESERVED D05: draft/CanHire.can, draft/CanHire.md, draft/CanHire.mjs — writer 01a106ee-0e65-7670-9327-063030f84315 (D05 CanHire/5) batch 2 active.
