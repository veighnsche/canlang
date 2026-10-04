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
- design/evaluation/** snapshots + evidence experiments: frozen evaluation artifacts, referenced only from EVALUATION.md/briefs/verification.json, not build/test inputs.
- editors/vscode/audit-astra/** snapshots + probes: frozen audit evidence, referenced only from AUDIT-RESOLUTION.md/GRAMMAR-AUDIT.md, not build/test inputs.
- design/*witness.can (canonical-exposure, historical-intake, delivery-recipe, optional-dependency x2, rent-history): frozen decision-evidence witnesses referenced from decision docs, not live inputs.
- No maintained .can conformance/negative fixtures found outside the above (compiler tests use inline sources + examples/; parser tests use draft/+examples/).
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
- D2 L5 full 68-component library + right-sidebar shell: NOT shipped (main has S1-S4 small-subset scope; S5 pending in PR #34).
  Owner: lane 05 (steering is the user's paste of prompts/05-ui-steering.md). Migration sources will use approved-but-unimplemented profiles; gaps recorded per slice.
- D3 L1 catalog consumption (checking/codegen/completion/highlighting): NOT shipped (B0 syntax merged in #30). Owner: lane 01.
  Parser/highlighter acceptance of new component words cannot be assumed; approval != support.
- D4 L6 canonical login/identity/transport: partial (S4 HTTP merged #22, S5 MCP pending #32). Login-screen migration is presentation selection, never rebuilt auth.
- D5 unmerged primary apps (CanKnowledge/CanInbox/CanDiscover/CanSync/others): owned by primary draft writers; excluded until merged.

## Worker reservations (disjoint files; workers never run git/fetch/worktree)

- Coordinator: status file, all git/gh, slice branches, shared-package files unless explicitly reserved.
- (No workers spawned yet; at most two implementers to start. Reviewers always read-only and independent of the author.)

## Reviewed heads and merged PRs

- (Pending slice 0.)
