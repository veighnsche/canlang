# Frontend catalog migration (lane 08)

Coordinator: Muse Code 1.3 Contributor (human-launched). Session: 01a10772-253f-79c3-a6e6-d2cff9a2d483.
Native goal: goal-01a10773-5ba9-7a71-be2e-d0d22adba198 (whole outcome, no token budget).
Owned worktree: /Users/vince/Projects/canlang-worktrees/frontend-catalog-migration (from origin/main, never the primary checkout or another lane worktree).
Branch prefix: muse/frontend-catalog-migration/. Primary checkout is read-only metadata (dirty, ahead/behind; never reset, edited or copied from except the authorized doc blobs below).

Brief: implementation/briefs/08-frontend-catalog-migration.md. Handoff: implementation/UI-CATALOG-ADOPTION.md.
Scope: migrate active authored .can frontends to the approved full 68-component daisyUI vocabulary with the shared static shell
(right-sidebar page menu, bottom-right user menu, common user configuration dialog, canonical login screen).
Lane 05 owns the UI library and typed catalog; lane 08 never edits producer code. 08 owns drafts/examples migration + applicable companions.

## Base verification (docs handoff)

origin/main at worktree creation: 727ab61 (Lane 04 S5+S6 #24, fetched 2026-10-04).
Approved docs were ABSENT from origin/main (UI-CATALOG-ADOPTION.md, briefs/05-ui.md, briefs/08-frontend-catalog-migration.md,
prompts/05-ui-steering.md, design/UI-COMPONENTS.md all absent; JEV daisyui-catalog evidence absent).
Verified handoff chain on the primary's object store (read-only, working tree untouched):
- 9eaa4e2 docs(ui): propose full daisyui vocabulary — doc-only (UI-COMPONENTS.md proposal + 8 JEV evidence files).
- 706c70a mixed commit — UI-only extraction limited to the 11 handoff paths; full diff inspected (/tmp/ui-doc-diff.patch in coordinator session).
  App/design-JEV/draft changes in that commit are excluded.
- e745733 docs(ui): handoff doc + small 08-prompt correction — doc-only, inspected.
- 87f9bee docs(ui): shorten prompts, add briefs + steering prompt — doc-only, inspected. Intermediate draft commits 3d41233/13071ec do not touch these paths.
- origin/main has zero changes to any handoff path since merge-base b06d873, so staged normative hunks were verified byte-identical
  (md5 of +/- lines) to the authorized 9eaa4e2..706c70a diff on all 8 stable paths; new-file blobs verified by hash against 706c70a/87f9bee.

## Inventory (against origin/main 727ab61 + staged docs; final re-check at completion)

Active authored sources to migrate (44): every path below is a live input to tools/test_can_parser.py and/or compiler/tests.
- draft/CanAffiliate, CanApprove, CanBoard, CanBook, CanCRM, CanCatch, CanCheck, CanContract, CanCustomer, CanDesk, CanDo,
  CanEvent, CanExpense, CanFeedback, CanField, CanGrant, CanHire, CanInvoice, CanLearn, CanLeave, CanLoyalty, CanMail,
  CanMaintain, CanMember, CanOnboard, CanPropose, CanPurchase, CanReception, CanRefer, CanRent, CanReport, CanShift,
  CanStats, CanStock, CanSuccess, CanTable, CanTime, CanTrade, CanVolunteer (.can, 39 apps)
- draft/shared/Employees.can, draft/shared/Locations.can, draft/shared/Suppliers.can (3 active shared packages)
- examples/ExpenseFlow.can, examples/TeamTasks.can (2 reference examples)
Applicable companions: 21 draft/*.mjs desired-output witnesses + 39 draft/Can*.md app companions (+ draft README/MIGRATION/PORTFOLIO/WORKSPACE_OPERATOR/ADMIN_SURFACES where frontend statements contradict migration).
No draft/shared/*.md and no examples companions exist.

Excluded with reason (197 total .can files; 153 excluded):
- design/evaluation/** snapshots + evidence experiments: frozen evaluation artifacts, referenced from evaluation/decision docs (EVALUATION.md, briefs/, verification.json, draft/MIGRATION.md, JEV assessments), not build/test inputs.
- editors/vscode/audit-astra/** snapshots + probes: frozen audit evidence, referenced only from AUDIT-RESOLUTION.md/GRAMMAR-AUDIT.md, not build/test inputs.
- design/*witness.can (canonical-exposure, historical-intake, delivery-recipe, optional-dependency x2, rent-history): frozen decision-evidence witnesses referenced from decision docs, not live inputs.
- No maintained .can conformance/negative fixtures found outside the above (compiler tests use inline sources + examples/ + draft/ recursively per syntax.rs:71-72; parser tests glob the same 44 via examples/ + draft/ + draft/shared/ per test_can_parser.py:494-496).
- Unmerged primary-writer apps (CanKnowledge, CanInbox, CanDiscover, CanSync, CanChat, CanCreative, CanGallery, dirty/working-tree drafts):
  explicit owner dependency, NOT copied. Tracked below; included only after their owner merges them.

## Finite plan (checklist, not a catalog)

- [x] Slice 0 docs handoff PR (this branch): staged UI-only docs + this status file. Review, check, merge, fetch.
- [ ] Per-app baseline capture (routes, operations/forms, scopes, preferences, journeys, BDD) for the 44 active sources.
- [ ] Migration slices in coherent app batches (exact paths listed per slice before editing), each: migrate .can presentation,
      update contradicting .mjs witnesses/.md companions or record no-change, independent diff review, checks, merge, fetch fresh main.
- [ ] Producer-gap ledger per slice: approved-but-unimplemented component profiles used, with owner + consuming example.
- [ ] Final inventory vs refreshed origin/main; shell-consistency verification across representative apps; close goal.
Component selection rule: smallest useful substitutions serving each app's actual journeys; no decorative controls, no second catalog.
New-syntax adoption rule: approved catalog bindings only; record execution gaps explicitly (approval != shipped support).

## Dependencies

- D1 draft-file release: brief requires release from the current draft coordinator before writing draft/. No direct contact found
  (primary writers include Codex/Astra sessions; peer-session identities unverified). Release requested via this committed status
  and PR descriptions. Mitigation: edit only merged files, never unmerged primary apps; rebase before every PR so conflicts surface for review.
- D2 L5 full 68-component library + right-sidebar shell: NOT shipped (main has S1-S5 small-subset scope; S5 merged in #34).
  Owner: lane 05 (steering is the user's paste of prompts/05-ui-steering.md). Migration sources will use approved-but-unimplemented profiles; gaps recorded per slice.
- D3 L1 catalog consumption (checking/codegen/completion/highlighting): NOT shipped (B0 syntax merged in #30, CLI/LSP in #36). Owner: lane 01.
  Parser/highlighter acceptance of new component words cannot be assumed; approval != support.
  Concrete impact: slice 1's two `badge` lines turn L1's golden_corpus_parses_clean red on main (E1200 invalid syntax shape;
  base was 0 failures, measured 2026-10-04). Each migration slice will note its exact new-word lines so L1 reconciliation stays mechanical; no test files touched here.
- D4 L6 canonical login/identity/transport: partial (S4 HTTP merged #22, S5 MCP pending #32). Login-screen migration is presentation selection, never rebuilt auth.
- D5 unmerged primary apps (CanKnowledge/CanInbox/CanDiscover/CanSync/others): owned by primary draft writers; excluded until merged.
- D6 (to L1, nit from PR #35 review): GRAMMAR.md header-attribute table label "| calendar agenda |" is ambiguous — the row covers only the start/end-required agenda production while the bare-selector date control lives in prose + UI-COMPONENTS.md. Suggested "| calendar (agenda) |". Not edited here: carried normative text stays verbatim with its owner.

## Worker reservations (disjoint files; workers never run git/fetch/worktree)

- Coordinator: status file, all git/gh, slice branches, shared-package files unless explicitly reserved.
- (No workers spawned yet; at most two implementers to start. Reviewers always read-only and independent of the author.)

## Reviewed heads and merged PRs

- PR #35 docs handoff: reviewed head d241592 (substance reviewed at 88733c7; delta was the reviewer's own 3-line status fix + conflict-free rebase onto fb226e0), tools+workspace green, squash-merged as 2451d85. URL: https://github.com/veighnsche/canlang/pull/35
- PR #39 slice 1 examples: reviewed head 730b2a7 (substance fefe3a3 approve-with-nits; delta was the 2 requested status nits), tools+workspace green, squash-merged as fab9ba0. URL: https://github.com/veighnsche/canlang/pull/39. Golden-corpus impact live on main: 2 E1200 (badge lines), L1 track.
- PR #43 slice 2 batch A: reviewed head 7853b06 (substance 4acba2f approve-with-nits; delta was the 1 requested status nit; rebased onto 742c618 L2 PR5, disjoint), tools+workspace green, squash-merged as cc67da7. URL: https://github.com/veighnsche/canlang/pull/43. Golden-corpus impact live on main: 26 E1200 (2 examples + 24 batch A), L1 track.
- PR #46 slice 4 docs sync: reviewed head ece84f5 (substance cc6fe88 approve-with-nits; delta was the 6 requested one-word nits; base 3819b23 L6 #44, disjoint), tools+workspace green, squash-merged as ef02fdc. URL: https://github.com/veighnsche/canlang/pull/46. Draft-first direction now on main.

## Slice 5: full replans Contract/Stock/Catch/CRM (branch muse/frontend-catalog-migration/slice-05-replan-1, in progress)

Paths: draft/CanContract (.can+.md), CanStock (.can+.md+.mjs), CanCatch (.can+.md), CanCRM (.can+.md+.mjs) + this status file.
Workers (disjoint, no git): W-E Contract/Stock; W-F Catch/CRM. Calibration slice: 2 apps per worker.
Replan bar: per-app frontend plan (users/tasks, pages+composition, families/bindings, states, defaults, source-target map);
complete Then rewrite with the full vocabulary where journeys warrant; faithful .mjs with actual desired composition and
minimal proposed @canlang/ui contracts labeled desired/unimplemented; .md updates; handoff notes (behaviors, acceptance,
exact gaps/owners). Given/When byte-identical; shared shell untouched; drift measured centrally by coordinator.
Outcome: all 4 Then-only verified (hunks start Contract L154/Then L153, Stock L167/Then L166, Catch L171/Then L170,
CRM L140/Then L139). Coordinator fixes: removed 1 computed-query badge (Catch indicator count(...where...)) with
.md correction; 1 Contract pagination indent fix. Witnesses: CRM + Stock faithful desired .mjs (node --check clean,
proposed @canlang/ui labeled desired/unimplemented, no await-L5 leftovers); Catch/Contract have no .mjs (gap).
Drift: +142 E1200 (Contract 36, Stock 30, Catch 30, CRM 46) over 26 baseline = 168 across 16 files; test fails on
main too (untouched baseline files FAIL in this run), recorded L1 gap, never gates drafting. Prototype parser:
Stock/CRM stop at breadcrumbs (expected new vocab); Contract/Catch stop at pre-existing Given type-gap errors
(byte-identical on HEAD baseline). Handoff: reviewed .can/desired-.mjs pairs + exact gaps to 05/01 via PR.

## Steering: draft-first full replans (received 2026-10-04 ~17:45)

User steering + corrected docs placed in this worktree (single batch, 17:44; verified as user corrections, not worker drift):
corrected briefs/08 (draft-first frontend design), and matching draft-first corrections to UI-COMPONENTS, PLAN, CONTRACTS,
WORKFLOW, UI-CATALOG-ADOPTION, briefs/05, prompts/01-language, prompts/05-ui, prompts/05-ui-steering, prompts/08, plus new
prompts/08-frontend-catalog-steering.md. Badge-insertion passes are insufficient; each app gets a full frontend replan.
08's reviewed .can/desired-.mjs pairs drive 05's library and 01's compiler; implementation gaps never gate drafting.
Witnesses must express actual desired composition/bindings with minimal proposed @canlang/ui contracts labeled
desired/unimplemented — "await L5" comments are not the lowering and will be replaced.
In-flight badge workers C/D were cancelled; their partial batch-B edits reverted (full replans supersede).
ui-ux-pro-max skill assessed: its styling/palette/landing workflow is inapplicable (renderer owns all styling; finite theme
tokens; no app-level CSS). Portable UX rules (states, focus, no-color-alone, reduced-motion) are already normative in
DESIGN §9 + UI-COMPONENTS, which govern. No separate design system will be introduced.

## Revised finite plan

- Slice 4 (docs sync, in progress): carry the user doc corrections above into a reviewed docs PR. Then replan slices.
- Replan slices (full frontend per app: users/tasks, pages+composition, component families/bindings, complete states,
  defaults, source-target mapping recorded compactly before/with source): batch B (10 unstarted apps) in ~3 slices of
  3-4 apps; batch C/D/E similarly; giants (Rent/Invoice/Member) 1 app per slice; shared/* no-change by whole-app review.
- Rework slices: reference examples + batch A reassessed under the full-replan bar; keep useful badge/content lines,
  complete the whole-frontend design and replace await-L5 comments with faithful desired lowerings.
- Every slice hands reviewed source/target pairs + exact gaps/owners to 05/01 via status + PR descriptions.
- Golden-corpus/parser drift reporting continues per slice as 01 gaps; draft design is never gated on them.

## Slice 2: batch A drafts (branch muse/frontend-catalog-migration/slice-02-drafts-a, in progress)

Paths: draft/CanTrade, CanReport, CanDo, CanTable, CanBoard (.can+.md; .mjs for Table, Board) + draft/CanOnboard, CanCheck, CanLearn, CanStats, CanSuccess (.can+.md; .mjs for Onboard, Check) + this status file.
Workers (disjoint, no git): W-A Trade/Report/Do/Table/Board; W-B Onboard/Check/Learn/Stats/Success.
Execution notes: W-B completed its files directly (10 badges; coordinator removed 1 as redundant/contract-stretching: CanLearn `badge any(...)` duplicated the adjacent text line with no owning captions). W-A lost file/shell tools (EMFILE, then tool grant restricted); coordinator applied W-A's extracted apply-spec verbatim after verifying each find against the files (15 badges + 4 contents). All hunks verified below each file's Then line; `node --check` passes on all 4 edited .mjs.
Changes (Then-only; Given/When/BDD byte-identical):
- CanTrade L90 badge state + L91 content description; L100 badge state; L116 badge resolved; L121 badge state.
- CanReport L126 badge Run state. CanDo L124-125 badges done+priority; L128/L134 content description/body; L144/L147/L150 badge state.
- CanTable L152 badge Booking state. CanBoard L131 badge finalized; L144 badge outcome; L148/L167 badge done; L159 content amendment text.
- CanOnboard L145/L164 badge done, L173 badge active. CanCheck L170 badge state. CanLearn L151 badge active. CanStats L160 badge active, L164 badge result.state, L173 badge state. CanSuccess L158 badge risk.
- Total: 24 added `badge` lines (approved, L1/L5 unimplemented) + 4 added `content` lines (existing core word, no gap).
Companions: 4 .mjs witnesses got honest pending-contract comments at matching renderRows (Table 1, Board 5, Onboard 3, Check 1); no invented imports. All 10 .md unchanged with justification: each already specifies the presentation (Badge mentions in Report/Do/Board/Onboard/Check/Learn/Stats/Success; Trade's status presentation table and Table's color-alone rule, which the text-bearing badges satisfy).
Drift: golden_corpus E1200 counts per file equal badge counts exactly (24 total over these 10 files; content lines clean). Prototype: badge reached in Trade/Report/Table/Board; other 6 files fail on pre-existing Given/When lines first (sequence syntax, array-nullable suffixes, poll, preference-dispatched order).

## Slice 1: reference examples (branch muse/frontend-catalog-migration/slice-01-examples)

Paths: examples/TeamTasks.can, examples/ExpenseFlow.can, this status file. No companions exist for examples (no .mjs/.md). No shared-package files.
Baselines (pre-migration, from origin/main 2451d85):
- TeamTasks (51 lines): app TeamTasks page / (inline Todo.create form; task-count text; tabs preferences.view; Todo list with edit/delete; empty state); app TeamNotes page /notes (inline Note.create form; Note split list with edit/delete + details open=preferences.show_content showing row.content); app TeamOffice uses=[TeamTasks,TeamNotes]. BDD: update examples incl. conflict/forbidden rows.
- ExpenseFlow (108 lines): package expenses page / (Expense.create drawer form; Expense split list with edit/actions submit,approve,reject/history; filter=status with preferences default); package reporting page /reports (tabs preferences.status; inline summarize form with metrics result.count,result.total). BDD: submit/approve/reject tables + shared-state sequence (parser-unimplemented, noted inline).
Choices (smallest journey-serving substitutions; everything else demonstrated already compliant):
- +`badge row.done` (Todo list): per-row completion state with owning done/Open captions. +`badge row.status` (Expense list): per-row Draft/Submitted/Approved/Rejected state. Both are the catalog's badge leaf on readable row values; no new strings.
- `text row.content` -> `content row.content` (note body): paragraph-preserving presentation for multi-line note content; existing core word.
- Kept as-is (already compliant): bare inline forms (complete generated remainder), tabs bound to owned enum preferences, edit/delete/actions/history canonical controls, details compatibility spelling, metrics shared contract, display=split, empty/filter/defaults states.
Producer gaps used by this slice: `badge` is approved-but-unimplemented (L1 parser/checker + L5 renderer; D2/D3). `content` is existing core vocabulary, no gap.
Corpus-drift note: the Python prototype corpus test and the Rust golden-corpus test predate the catalog and reject `badge`; CI's tools job already excludes the corpus test and corpus parse is informational (continue-on-error); lane-01 CI is path-filtered (compiler/**, editors/vscode/**, two contract files) and does not trigger on examples/**. Drift reconciliation belongs to L1/B4; no test files touched here.
