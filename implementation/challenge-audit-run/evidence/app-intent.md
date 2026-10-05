# T02 per-file intent inventory (PREPARATION — parent T02 stays open until T01 lands)

- Scope: all 49 top-level `draft/Can*.can` apps.
- Revisions: main checkout `e22b59f` (branch codex/challenge-audit-implementation, base c681d86);
  draft submodule `2d67312` (clean, heads/main). No builds run; read-only inspection only.
- T01 status: `implementation/challenge-audit-run/evidence/root-causes.md` ABSENT at prep time
  (evidence/ holds only `execution-contract.md`). Every disposition below is a PLACEHOLDER.
  T01 reconciliation pending for all 49 apps; nothing here is an adjudicated verdict.
- Plan inputs: `implementation/CHALLENGE-AUDIT-PLAN.md` observed baseline (4524 diagnostics /
  52 sources; 830 runtime error expectations; no explicit whole-file compile-negative intent),
  Executable-examples section (accept-workflow-intent recommendation, runtime negatives
  preserved), L7 lane (T02/T21-T23/T37-T41), four unadopted `each=` sites in Shift/Volunteer.

## Method (reproducible greps, all run from `draft/`)

- Runtime error expectations: `grep -o "-> error(" *.can` → **830**, matching the audit count.
  Kinds: `rule_failed`=613, `forbidden`=182, `conflict`=31, `validation`=2, `not_found`=2.
- Shared-state `do` example blocks: lines matching `^    do$` (4-space indent; validated by
  sampling that each directly follows an `examples seed=[...]` line) → 25 files contain them.
- Proposal markers: `##` comments using proposed/parser/grammar/pending/desired/yet/support,
  hand-triaged to exclude domain language (proposal stages, fixtures named `proposed`,
  "future runs", "proposed change" business text).
- Whole-file compile-negative intent: case-insensitive grep for
  `should not compile|must not compile|compile-negative|invalid app|negative fixture|
  deliberately invalid|intentionally invalid` → **no matches (exit 1)**. No whole-file
  negatives recorded, consistent with the plan.
- Run-wide (not per-app) unavailable capability, by plan reference only: testkit loader
  substitutes no-op/unsupported invocation and the e2e loader rejects the compiled path
  (plan Executable-examples section; owned by T21-T23, not adjudicated here).

## T01 plug-in slot

Each app entry ends with a `T01:` line. T01 fills in ledger reference, bucket (a-e),
verdict, and flip evidence without restructuring this file.

## Apps (49/49)

### 1. CanAffiliate.can — `app CanAffiliate uses=[affiliate]`

- Intent: pay brokers, relocation agencies, and commercial partners for qualifying sales.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x6 (rule_failed=5, forbidden=1); `do` example blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 6 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 2. CanApprove.can — `app CanApprove uses=[approve]`

- Intent: managers review fit-out plans, signage, supplier documents, procedures pre-use.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x41 (rule_failed=28, conflict=6, forbidden=6, not_found=1);
  `do` example blocks x3.
- Proposal markers: L117 `##` "Shared-state journeys use the proposed sequence grammar;
  the unchanged syntax parser does not accept do examples."
- Unavailable-implementation markers: `do`-example sequence grammar per L117 comment
  (direct evidence: comment + 3 `do` blocks present).
- Runtime negatives: 41 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 3. CanBoard.can — `app CanBoard uses=[board]`

- Intent: leadership/advisory board prepares meetings, then records resolutions.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x19 (rule_failed=13, forbidden=6); `do` blocks x0.
  (`proposed` is a Resolution outcome enum value — domain language, not a marker.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 19 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 4. CanBook.can — `app CanBook uses=[appointments]`

- Intent: customers book site tours, sales consultations, onboarding appointments.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x14 (rule_failed=8, forbidden=5, conflict=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 14 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 5. CanCRM.can — `app CanCRM uses=[crm,customer,appointments,propose]`

- Intent: sales teams turn inquiries into tours, quotes, and office/coworking sales.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x21 (rule_failed=14, forbidden=7); `do` blocks x0.
  Multi-package app; Proposal/Revision forms are imported CanPropose-owned (domain use).
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 21 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 6. CanCatch.can — `app CanCatch uses=[catch]`

- Intent: triage JavaScript errors in booking, member, billing, and staff apps.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x8 (rule_failed=6, forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 8 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 7. CanChat.can — `app CanChat uses=[chat]`

- Intent: private company conversations with visible generation progress, branches,
  membership and resource limits.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x7 (rule_failed=7); `do` blocks x1 (no parser note attached).
  (`sequence=` is a TextRun field name, not the sequence grammar.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 7 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 8. CanCheck.can — `app CanCheck uses=[check]`

- Intent: detect missed check-ins from reconciliation, reminders, imports, jobs.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x12 (rule_failed=10, forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 12 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 9. CanContract.can — `app CanContract uses=[agreements]`

- Intent: track occupancy, property, and supplier contracts with obligations/notices.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x5 (rule_failed=3, forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 5 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 10. CanCreative.can — `app CanCreative uses=[chat,creative]`

- Intent: turn private ideas into bounded image jobs via published workflow revisions.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x8 (rule_failed=7, forbidden=1); `do` blocks x0.
  (`sequence=` is an ImageRun field name, not the sequence grammar.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 8 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 11. CanCustomer.can — `app CanCustomer uses=[customer]` + L5 `app CustomerSales`

- Intent: customer identity and company-administration package; L5 composes
  CustomerSales from CanCustomer/CanCRM/CanBook/CanPropose/CanSuccess.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x10 (rule_failed=8, forbidden=2); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 10 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 12. CanDecide.can — `app CanDecide uses=[decide]`

- Intent: review model-generated decision briefs/alternatives before one advisory
  judgment and an explicit human choice.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x16 (rule_failed=13, forbidden=3); `do` blocks x4.
  ("proposal"/"proposed" are brief-domain language, not grammar markers.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 16 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 13. CanDesk.can — `app CanDesk uses=[desk]`

- Intent: reception/support handle booking changes, billing, Wi-Fi, service requests.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x17 (forbidden=9, rule_failed=8); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 17 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 14. CanDiscover.can — `app CanDiscover uses=[discover]`

- Intent: monitor two declared opportunity sources; promote only staff-reviewed evidence.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x14 (rule_failed=9, forbidden=4, conflict=1);
  `do` blocks x3. L97 `##` "Shared-state operation sequence; queued effects stay
  isolated and never contact providers." (describes semantics; makes no parser claim).
  "future runs" is scheduling-domain language.
- Proposal markers: none observed (no proposed-grammar/parser comment in file).
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 14 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 15. CanDo.can — `app CanDo uses=[todo]`

- Intent: staff coordinate opening/closing, room prep, and customer follow-up tasks.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x1 (rule_failed=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 1 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 16. CanEnrich.can — `app CanEnrich uses=[enrich]`

- Intent: enrich known companies with reviewed registry facts and retained evidence.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x10 (rule_failed=7, forbidden=3); `do` blocks x2.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 10 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 17. CanEvent.can — `app CanEvent uses=[events,invoice]`

- Intent: community teams sell/allocate places at sessions, workshops, events.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x16 (rule_failed=12, forbidden=4); `do` blocks x0.
  (Fixture named `proposed` and "proposed change" are Change-domain language.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 16 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 18. CanExpense.can — `app CanExpense uses=[expense]`

- Intent: employees claim approved travel, emergency supplies, out-of-pocket expenses.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x72 (rule_failed=52, forbidden=12, conflict=8);
  `do` blocks x6 — highest `do` and error counts in the corpus.
- Proposal markers: L39 `##` "connected sequences below use real calls and commits
  under the proposed example contract."; L114 `##` "Shared-state journeys use the
  proposed sequence grammar; the initial parser does not accept this form yet."
- Unavailable-implementation markers: `do`-example sequence grammar per L39/L114
  comments (direct evidence: comments + 6 `do` blocks present).
- Runtime negatives: 72 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 19. CanFeedback.can — `app CanFeedback uses=[feedback]`

- Intent: members suggest facility/amenity/booking improvements; see operator response.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x22 (rule_failed=17, forbidden=5); `do` blocks x2.
  (`proposed` is a Suggestion status enum value — domain language.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 22 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 20. CanField.can — `app CanField uses=[field]`

- Intent: dispatch technicians, cleaners, setup staff for on-site service visits.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x2 (rule_failed=1, forbidden=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 2 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 21. CanGallery.can — `app CanGallery uses=[chat,creative,gallery]`

- Intent: review finalized creative assets; share approved collections without
  exposing private conversations.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x7 (rule_failed=6, forbidden=1); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 7 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 22. CanGrant.can — `app CanGrant uses=[grant]`

- Intent: run a funded startup/community program awarding monetary support.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x49 (rule_failed=38, forbidden=6, conflict=4,
  validation=1); `do` blocks x4.
- Proposal markers: L93 `##` "Shared-state sequences are proposed; the initial
  parser does not support their do grammar. Static user grants are not a live
  role-revocation event."
- Unavailable-implementation markers: `do`-example sequence grammar per L93 comment
  (direct evidence: comment + 4 `do` blocks present).
- Runtime negatives: 49 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 23. CanHire.can — `app CanHire uses=[hire]` + L5 `app PeopleDevelopment`

- Intent: recruit location staff; L5 composes PeopleDevelopment from
  CanHire/CanOnboard/CanLearn.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x17 (rule_failed=11, forbidden=6); `do` blocks x1.
  (Fixture named `proposed` is Interview-domain language.)
- Proposal markers: L333 `##` "Static pipeline legend; per-stage highlight of the
  current candidate is desired behavior pending a catalog selection binding
  (proposed)."
- Unavailable-implementation markers: catalog selection binding for per-stage
  highlight, per L333 (direct evidence: comment text).
- Runtime negatives: 17 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 24. CanInbox.can — `app CanInbox uses=[inbox]`

- Intent: classify departmental email, review queue transfers, send evidenced replies.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x19 (rule_failed=16, forbidden=3); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 19 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 25. CanInvoice.can — `app CanInvoice uses=[invoice]` + L5 `app Finance`

- Intent: issue readable invoices for offices, desks, rooms, memberships, add-ons;
  L5 composes Finance from CanInvoice/CanExpense/CanPurchase/CanReport.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x56 (rule_failed=40, forbidden=13, conflict=3);
  `do` blocks x1.
- Proposal markers: L921 `##` "proposed: email as input's "appropriate scalar";
  checker confirms."
- Unavailable-implementation markers: none directly evidenced (scalar proposal is a
  checker-confirmation note, not a stated absence; T01 to adjudicate).
- Runtime negatives: 56 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 26. CanKnowledge.can — `app CanKnowledge uses=[knowledge]`

- Intent: publish reviewed procedures; answer private questions with current evidence.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x18 (rule_failed=12, forbidden=6); `do` blocks x4.
  ("Propose revision" is a scenario label — domain language.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 18 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 27. CanLearn.can — `app CanLearn uses=[learn]`

- Intent: text-based staff induction, safety procedures, member orientation.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x7 (rule_failed=6, forbidden=1); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 7 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 28. CanLeave.can — `app CanLeave uses=[leave]`

- Intent: staff request time off; managers see absences and plan coverage.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x7 (rule_failed=6, forbidden=1); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 7 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 29. CanLoyalty.can — `app CanLoyalty uses=[loyalty]`

- Intent: reward repeat paid visits with points, tiers, fulfillable perks.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x22 (rule_failed=16, forbidden=4, conflict=1,
  validation=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 22 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 30. CanMail.can — `app CanMail uses=[mailroom]`

- Intent: receive/deliver customer mail and parcels for on-site/virtual customers.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x27 (rule_failed=24, forbidden=3); `do` blocks x1.
  ("future service availability" is domain language.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 27 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 31. CanMaintain.can — `app CanMaintain uses=[maintain]` + L5 `app Facilities`

- Intent: move facility faults through repair and return to service; L5 composes
  Facilities from CanMaintain/CanField/CanStock.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x20 (rule_failed=13, forbidden=6, conflict=1);
  `do` blocks x3.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 20 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 32. CanMember.can — `app CanMember uses=[member_plans,member_terms,member_content,rent_fulfillment,invoice,desk,events]`

- Intent: manage paid membership terms and a customer member portal.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x11 (rule_failed=10, not_found=1); `do` blocks x2.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 11 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 33. CanOnboard.can — `app CanOnboard uses=[employee,onboard]`

- Intent: HR/location managers prepare new employees for their duties.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x11 (rule_failed=9, forbidden=2); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 11 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 34. CanPropose.can — `app CanPropose uses=[propose]`

- Intent: sales teams quote offices, meeting rooms, coworking days, add-on services.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x24 (rule_failed=17, forbidden=5, conflict=2);
  `do` blocks x1. (Proposal/Revision are the app's own domain models.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 24 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 35. CanPurchase.can — `app CanPurchase uses=[supplier,purchase]`

- Intent: authorize furniture, supplies, repairs, spending against budgets.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x44 (rule_failed=33, forbidden=10, conflict=1);
  `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 44 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 36. CanReception.can — `app CanReception uses=[reception]`

- Intent: register visitors, check arrivals/departures, track keys/cards.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x11 (rule_failed=8, forbidden=3); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 11 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 37. CanRefer.can — `app CanRefer uses=[refer]` + L5 `app ReferralsPartners`

- Intent: members/advocates earn fixed cash rewards for qualifying new customers;
  L5 composes ReferralsPartners from CanRefer/CanAffiliate.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x14 (rule_failed=11, forbidden=3); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 14 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 38. CanRent.can — `app CanRent uses=[rent_catalog,rent_catalog_ui,rent_reservations,rent_fulfillment,rent_reporting]` + L5 `app Workspace`

- Intent: authoritative booking app for desks, day offices, meeting rooms, event
  spaces; L5 composes Workspace from CanRent/CanMember/CanReport.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x26 (rule_failed=20, forbidden=5, conflict=1);
  `do` blocks x0. (`sequence` is a policy/evidence field name — domain language.)
- Proposal markers: five `##` "proposed: <scalar> as input's "appropriate scalar";
  checker confirms." at L1503 (money), L1515 (money), L1595 (email), L1649 (int),
  L1800 (money).
- Unavailable-implementation markers: none directly evidenced (scalar proposals are
  checker-confirmation notes, not stated absences; T01 to adjudicate).
- Runtime negatives: 26 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 39. CanReport.can — `app CanReport uses=[report]`

- Intent: scoped operational reporting package for managers and finance.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x2 (forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 2 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 40. CanShift.can — `app CanShift uses=[shift]` + L5 `app StaffScheduling`

- Intent: roster reception/community/sales/facilities staff; arrange replacements;
  L5 composes StaffScheduling from CanLeave/CanShift.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x14 (rule_failed=12, forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: `each=` fanout at L237
  (`scenario review_commitment on=EligibilityReview each=Commitment as commitment`)
  and L243 (`scenario review_swap on=EligibilityReview each=Swap as swap`).
  Plan confirms `each=` unadopted (Scoped-fanout section; T33/T34 own the decision).
- Runtime negatives: 14 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 41. CanStats.can — `app CanStats uses=[stats]`

- Intent: marketing teams understand traffic and tracked inquiries on pages.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x6 (rule_failed=5, forbidden=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 6 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 42. CanStock.can — `app CanStock uses=[stock]`

- Intent: track consumables by location and storeroom.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x4 (rule_failed=3, forbidden=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 4 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 43. CanSuccess.can — `app CanSuccess uses=[success]`

- Intent: account managers retain business customers (move-in, reviews, renewals).
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x4 (rule_failed=2, forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 4 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 44. CanSync.can — `app CanSync uses=[sync]`

- Intent: review bounded CRM corrections; preserve remote edits, uncertain evidence.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x13 (rule_failed=9, forbidden=4); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 13 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 45. CanTable.can — `app CanTable uses=[cafe]`

- Intent: reception/cafe staff seat guests at an on-site workspace cafe/restaurant.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x24 (rule_failed=16, forbidden=7, conflict=1);
  `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 24 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 46. CanTime.can — `app CanTime uses=[time]`

- Intent: teams record time on customer services, facilities work, projects.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x12 (rule_failed=9, forbidden=3); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 12 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 47. CanTrade.can — `app CanTrade uses=[trade]`

- Intent: members advertise services, request suppliers, offer surplus equipment.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x12 (rule_failed=7, forbidden=4, conflict=1);
  `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 12 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 48. CanVolunteer.can — `app CanVolunteer uses=[volunteer]`

- Intent: community teams organize member volunteers for sessions/events/charity.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x13 (rule_failed=10, forbidden=3); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: `each=` fanout at L47
  (`scenario refresh_reminders on=Opportunity.updated each=Signup as signup`) and
  L178 (`scenario cancel_signup on=OpportunityCancelled
  each=event.opportunity.Signup as signup`). Plan confirms `each=` unadopted
  (Scoped-fanout section; T33/T34 own the decision).
- Runtime negatives: 13 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

### 49. CanWorkbench.can — `app CanWorkbench uses=[workbench]`

- Intent: employees propose and explicitly approve bounded changes through owning
  business operations.
- Disposition: ACCEPTED-WORKFLOW-INTENT PLACEHOLDER — T01 PENDING.
- Observations: `-> error(` x15 (rule_failed=15); `do` blocks x7 — most `do`
  blocks in the corpus after Expense. ("proposed" fixture/scenario names are
  workbench-domain language.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 15 retained, never erased.
- T01: <ledger ref / bucket / verdict / flip evidence>

## Prep summary (for the coordinator)

- Coverage: 49/49 apps present, each with intent + observations + T01-pending marker.
- Runtime negatives: 830/830 `-> error(` expectations inventoried per file and marked
  retained (rule_failed=613, forbidden=182, conflict=31, validation=2, not_found=2).
  Zero erased, zero reclassified.
- Whole-file negatives: 0 recorded — no explicit whole-file compile-negative intent
  found by direct grep; matches plan baseline.
- Explicit proposal markers found in 6 files: CanApprove L117, CanExpense L39+L114,
  CanGrant L93 (sequence-grammar/parser); CanHire L333 (catalog binding);
  CanInvoice L921, CanRent L1503/L1515/L1595/L1649/L1800 (scalar proposals).
- Directly evidenced unavailable-implementation markers: `do`-grammar parser gap in
  Approve/Expense/Grant (per their own comments); `each=` fanout in Shift (2 sites)
  and Volunteer (2 sites, plan-confirmed unadopted); Hire catalog binding (comment).
- Notable non-adjudicated observation: 25 files contain `do` example blocks but only
  Approve/Expense/Grant carry explicit parser-rejection comments — recorded as-is
  for T01; no inference drawn.
- Multi-app files (second composing `app` at L5): Customer, Hire, Invoice, Maintain,
  Refer, Rent, Shift.
- T01 reconciliation pending for ALL 49 apps (root-causes.md absent at prep time).
  No dispositions invented. No other path touched; no heavy commands run (lock never
  acquired — none needed).
