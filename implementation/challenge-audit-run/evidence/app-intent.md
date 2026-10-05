# T02 per-file intent inventory (T01-RECONCILED — 49/49 dispositions evidence-backed)

- Scope: all 49 top-level `draft/Can*.can` apps.
- Revisions: main checkout `e22b59f` (branch codex/challenge-audit-implementation, base c681d86);
  draft submodule `2d67312` (clean, heads/main). No builds run; read-only inspection only.
- T01 status: `implementation/challenge-audit-run/evidence/root-causes.md` LANDED (T01 ticked
  complete: 30 roots R01-R30, buckets a-e, chains C1-C7, base c4a9775 + draft 2d67312).
  Every disposition below is reconciled against that ledger; nothing is a placeholder.
  Where the ledger is silent, the exact blocker is recorded instead of a guess.
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
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R01/R08/R10/R15 (b); open rules R16/R18 (c); no whole-file negative.
- Observations: `-> error(` x6 (rule_failed=5, forbidden=1); `do` example blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 6 retained, never erased.
- T01: R01(b,T03/T05) L88-96 else-narrowing; R08(b,T08) L253 `amount.currency` selector; R10(b,T10) L50 Qualification literal; R15(b,T30) L161/191-195 verified-ref writes; R16(c,T11) L23 integral decimal bounds; R18(c,T36+T10) L103 cross-enum compare; consequences C1/C2/C4/C5/C7. Verdict: workflow accepted. b-roots high-conf (flip: read-before-guard or unguarded mutation); R18 low-conf, flips either way (nominal mapping → draft fix; structural rule → b).

### 2. CanApprove.can — `app CanApprove uses=[approve]`

- Intent: managers review fit-out plans, signage, supplier documents, procedures pre-use.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R02/R07/R09/R12-send (b); UNRESOLVED PROPOSAL: do-grammar parser gap (no ledger root — blocker).
- Observations: `-> error(` x41 (rule_failed=28, conflict=6, forbidden=6, not_found=1);
  `do` example blocks x3.
- Proposal markers: L117 `##` "Shared-state journeys use the proposed sequence grammar;
  the unchanged syntax parser does not accept do examples."
- Unavailable-implementation markers: `do`-example sequence grammar per L117 comment
  (direct evidence: comment + 3 `do` blocks present).
- Runtime negatives: 41 retained, never erased.
- T01: R02(b,T03/T05) L264-269 AND-continuation (+C1 enum cases, C5 set-target); R07(b,T08) L18 parent/metadata selectors; R09(b,T09) L36 ordinary-array omission; R12(b,T13/T14) L44/L268 Mail.send opacity. Verdict: workflow accepted. BLOCKER (exact): L117 do-sequence-grammar parser rejection has no T01 root — grammar/parser adjudication unresolved; needs T23-scope/T36 decision, not guessed here.

### 3. CanBoard.can — `app CanBoard uses=[board]`

- Intent: leadership/advisory board prepares meetings, then records resolutions.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x19 (rule_failed=13, forbidden=6); `do` blocks x0.
  (`proposed` is a Resolution outcome enum value — domain language, not a marker.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 19 retained, never erased.
- T01: no ledger sites in this file (T01 is sampled; absence is not a clean bill). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Board — per-site capability attribution deferred to T02/T41 corpus re-attribution. Run-wide unavailable: T21-T23 compiled-example path (plan ref).

### 4. CanBook.can — `app CanBook uses=[appointments]`

- Intent: customers book site tours, sales consultations, onboarding appointments.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defect R11 (b); consequences C3/C4.
- Observations: `-> error(` x14 (rule_failed=8, forbidden=5, conflict=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 14 retained, never erased.
- T01: R11(b,T12/T13) L9 `use std` unwired (primary site; 1 of 24 files); C3: L24 DeliveryResult.status E3013 consequence; C4: Book-side `can_work` nullable-arg cascade (R03-R06-class, no Book-local continuation root sampled). Verdict: workflow accepted. R11 high-conf on missing production, medium per member (flip: member conflicts with actual owner contract).

### 5. CanCRM.can — `app CanCRM uses=[crm,customer,appointments,propose]`

- Intent: sales teams turn inquiries into tours, quotes, and office/coworking sales.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R05/R09/R10 (b); leaning draft defect R22 (a).
- Observations: `-> error(` x21 (rule_failed=14, forbidden=7); `do` blocks x0.
  Multi-package app; Proposal/Revision forms are imported CanPropose-owned (domain use).
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 21 retained, never erased.
- T01: R05(b,T03/T05) L30 invariant (primary site) + L43 guard (+C4 L28/43, C7 L414); R09(b,T09) L32 array omission; R10(b,T10) L34 ResearchLead literal; R22(a-leaning,T36) L47 server-owned `owner` as CRUD input (medium; flip: adopted privileged-input exception or proof not server-owned). Verdict: workflow accepted.

### 6. CanCatch.can — `app CanCatch uses=[catch]`

- Intent: triage JavaScript errors in booking, member, billing, and staff apps.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R05/R11/R13 (b).
- Observations: `-> error(` x8 (rule_failed=6, forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 8 retained, never erased.
- T01: R05(b,T03/T05) L91 OR-continuation (+C4 L81/93); R11(b,T12/T13) L10 std; R13(b, L1 queue resolution, exact slice TBD at G0) L4/L96-97 declared queue with no publish target/event source (DESIGN L593 contract; medium-high; flip: DESIGN row scoped out). Verdict: workflow accepted.

### 7. CanChat.can — `app CanChat uses=[chat]`

- Intent: private company conversations with visible generation progress, branches,
  membership and resource limits.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R03/R07/R11/R12 + R26-layer1 (b); read-fence rule R26-layer2 (c, pending T32).
- Observations: `-> error(` x7 (rule_failed=7); `do` blocks x1 (no parser note attached).
  (`sequence=` is a TextRun field name, not the sequence grammar.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 7 retained, never erased.
- T01: R03(b,T03/T05) L72-83 require-continuation (+C5 L80); R07(b,T08) L28 Run selectors; R11(b) L5 std; R12(b,T13/T14) L49/81 LLM.generate; R26 L15: layer1 b (AND-fact, T06) + layer2 c (authoritative-read purity, T32a/T32b fence — blocker: no adopted bounded-read contract); do x1 grammar status unadjudicated (run-wide caveat). Verdict: workflow accepted.

### 8. CanCheck.can — `app CanCheck uses=[check]`

- Intent: detect missed check-ins from reconciliation, reminders, imports, jobs.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R04/R05/R07/R15/R27 (b); ingress-secret rule R17 (c).
- Observations: `-> error(` x12 (rule_failed=10, forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 12 retained, never erased.
- T01: R04(b,T03/T05) L67-81 require-continuation (+C1 L72-76, C5 L70); R05(b) L53; R07(b,T08) L22; R15(b,T30) L128 verified ref; R27(b,T18+T31) L58-vs-L99 server-owned `armed` inconsistency (medium; flip: adopted default/server/update/hook rule); R17(c,T36) L11 supplied-secret ingress (medium; flip: adopted fenced form, else draft restructures → a); C6 hook-payload opacity L99-100. Verdict: workflow accepted.

### 9. CanContract.can — `app CanContract uses=[agreements]`

- Intent: track occupancy, property, and supplier contracts with obligations/notices.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R06/R07 (b) + R11-class consequence (C3).
- Observations: `-> error(` x5 (rule_failed=3, forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 5 retained, never erased.
- T01: R06(b,T03/T05) L34 invariant OR-continuation; R07(b,T08) L32 NoticeDelivery selectors; C3: L22 DeliveryResult E2001 std-opacity consequence (R11-class). Verdict: workflow accepted.

### 10. CanCreative.can — `app CanCreative uses=[chat,creative]`

- Intent: turn private ideas into bounded image jobs via published workflow revisions.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defect R11 (b); purity-gate rule R26-layer2 (c).
- Observations: `-> error(` x8 (rule_failed=7, forbidden=1); `do` blocks x0.
  (`sequence=` is an ImageRun field name, not the sequence grammar.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 8 retained, never erased.
- T01: R11(b,T12/T13) L8 std; R26-layer2(c,T32) L103 `when=`-guard authoritative-read purity (medium; blocker: T32a fence decision). Verdict: workflow accepted.

### 11. CanCustomer.can — `app CanCustomer uses=[customer]` + L5 `app CustomerSales`

- Intent: customer identity and company-administration package; L5 composes
  CustomerSales from CanCustomer/CanCRM/CanBook/CanPropose/CanSuccess.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x10 (rule_failed=8, forbidden=2); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 10 retained, never erased.
- T01: no ledger sites in this file (sampled; absence ≠ clean bill; L5 composition adds no cited sites). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Customer — per-site attribution deferred to T02/T41; do x1 grammar status unadjudicated (run-wide caveat). Run-wide unavailable: T21-T23.

### 12. CanDecide.can — `app CanDecide uses=[decide]`

- Intent: review model-generated decision briefs/alternatives before one advisory
  judgment and an explicit human choice.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b).
- Observations: `-> error(` x16 (rule_failed=13, forbidden=3); `do` blocks x4.
  ("proposal"/"proposed" are brief-domain language, not grammar markers.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 16 retained, never erased.
- T01: R11(b,T12/T13) L5 std (1 of 24; high-conf missing production, medium per member — flip: member conflicts with actual owner). Verdict: workflow accepted; do x4 grammar status unadjudicated (run-wide caveat).

### 13. CanDesk.can — `app CanDesk uses=[desk]`

- Intent: reception/support handle booking changes, billing, Wi-Fi, service requests.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R11 + R24 (b).
- Observations: `-> error(` x17 (forbidden=9, rule_failed=8); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 17 retained, never erased.
- T01: R11(b,T12/T13) L13 std; R24(b,T35) L139 payload `id` vs reserved metadata (medium; flip: observed field proves runtime metadata → a). Verdict: workflow accepted.

### 14. CanDiscover.can — `app CanDiscover uses=[discover]`

- Intent: monitor two declared opportunity sources; promote only staff-reviewed evidence.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x14 (rule_failed=9, forbidden=4, conflict=1);
  `do` blocks x3. L97 `##` "Shared-state operation sequence; queued effects stay
  isolated and never contact providers." (describes semantics; makes no parser claim).
  "future runs" is scheduling-domain language.
- Proposal markers: none observed (no proposed-grammar/parser comment in file).
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 14 retained, never erased.
- T01: no ledger sites in this file (sampled; absence ≠ clean bill). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Discover — per-site attribution deferred to T02/T41; do x3 grammar status unadjudicated (run-wide caveat; L97 makes no parser claim either way). Run-wide unavailable: T21-T23.

### 15. CanDo.can — `app CanDo uses=[todo]`

- Intent: staff coordinate opening/closing, room prep, and customer follow-up tasks.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defect R05 (b).
- Observations: `-> error(` x1 (rule_failed=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 1 retained, never erased.
- T01: R05(b,T03/T05) L131 Then-filter AND-continuation (+C7 E3005/E3002 consequences: `local_date(datetime?,…)` no-match, nullable-order). Verdict: workflow accepted.

### 16. CanEnrich.can — `app CanEnrich uses=[enrich]`

- Intent: enrich known companies with reviewed registry facts and retained evidence.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x10 (rule_failed=7, forbidden=3); `do` blocks x2.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 10 retained, never erased.
- T01: no ledger sites in this file (sampled; absence ≠ clean bill). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Enrich — per-site attribution deferred to T02/T41; do x2 grammar status unadjudicated (run-wide caveat). Run-wide unavailable: T21-T23.

### 17. CanEvent.can — `app CanEvent uses=[events,invoice]`

- Intent: community teams sell/allocate places at sessions, workshops, events.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R05/R11/R15/R25 (b); leaning draft defect R21 (a).
- Observations: `-> error(` x16 (rule_failed=12, forbidden=4); `do` blocks x0.
  (Fixture named `proposed` and "proposed change" are Change-domain language.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 16 retained, never erased.
- T01: R05(b,T03/T05) L72 (+C1 `confirmed`); R11(b) L12 std; R15(b,T30) L71-73 ordinary-parameter spelling (primary site; high-conf spelling fix); R25(b,T35+L2) L63 ICU select literals (medium-high; flip: accepted profile narrower → scoped-syntax decision d); R21(a-leaning,T36) L376 `money` scenario vs closed builtin (low-medium; flip: adopted namespace separation or second same-name use). Verdict: workflow accepted.

### 18. CanExpense.can — `app CanExpense uses=[expense]`

- Intent: employees claim approved travel, emergency supplies, out-of-pocket expenses.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defect R14 (b, JEV-gated); UNRESOLVED PROPOSAL: do-grammar/example-contract (no ledger root — blocker).
- Observations: `-> error(` x72 (rule_failed=52, forbidden=12, conflict=8);
  `do` blocks x6 — highest `do` and error counts in the corpus.
- Proposal markers: L39 `##` "connected sequences below use real calls and commits
  under the proposed example contract."; L114 `##` "Shared-state journeys use the
  proposed sequence grammar; the initial parser does not accept this form yet."
- Unavailable-implementation markers: `do`-example sequence grammar per L39/L114
  comments (direct evidence: comments + 6 `do` blocks present).
- Runtime negatives: 72 retained, never erased.
- T01: R14(b,T28→T29) L11 `Expense in Employee` imported containment (primary site; medium; flip: demonstrated unenforceable unsafety + concise alternative). Verdict: workflow accepted. BLOCKER 1: T28 JEV decision required before any R14 implementation. BLOCKER 2 (exact): L39/L114 proposed-example-contract/do-grammar notes have no T01 root — unresolved proposal, needs T23-scope/T36 adjudication, not guessed here.

### 19. CanFeedback.can — `app CanFeedback uses=[feedback]`

- Intent: members suggest facility/amenity/booking improvements; see operator response.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x22 (rule_failed=17, forbidden=5); `do` blocks x2.
  (`proposed` is a Suggestion status enum value — domain language.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 22 retained, never erased.
- T01: no ledger sites in this file (sampled; absence ≠ clean bill). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Feedback — per-site attribution deferred to T02/T41; do x2 grammar status unadjudicated (run-wide caveat). Run-wide unavailable: T21-T23.

### 20. CanField.can — `app CanField uses=[field]`

- Intent: dispatch technicians, cleaners, setup staff for on-site service visits.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x2 (rule_failed=1, forbidden=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 2 retained, never erased.
- T01: no ledger sites in this file (sampled; absence ≠ clean bill). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Field — per-site attribution deferred to T02/T41. Run-wide unavailable: T21-T23.

### 21. CanGallery.can — `app CanGallery uses=[chat,creative,gallery]`

- Intent: review finalized creative assets; share approved collections without
  exposing private conversations.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b).
- Observations: `-> error(` x7 (rule_failed=6, forbidden=1); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 7 retained, never erased.
- T01: R11(b,T12/T13) L8 std (1 of 24; high-conf missing production, medium per member — flip: member conflicts with actual owner). Verdict: workflow accepted; do x1 grammar status unadjudicated (run-wide caveat).

### 22. CanGrant.can — `app CanGrant uses=[grant]`

- Intent: run a funded startup/community program awarding monetary support.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R05/R11 (b); demonstrated draft defect R20 (a); UNRESOLVED PROPOSAL: do-grammar (no ledger root — blocker).
- Observations: `-> error(` x49 (rule_failed=38, forbidden=6, conflict=4,
  validation=1); `do` blocks x4.
- Proposal markers: L93 `##` "Shared-state sequences are proposed; the initial
  parser does not support their do grammar. Static user grants are not a live
  role-revocation event."
- Unavailable-implementation markers: `do`-example sequence grammar per L93 comment
  (direct evidence: comment + 4 `do` blocks present).
- Runtime negatives: 49 retained, never erased.
- T01: R05(b,T03/T05) L260 (+C7 `trim(text?)` E3005); R11(b) L8 std; R20(a,T36) L70 fixture cycle `state=submitted` (primary site; medium-high; flip: resolves to enum case with no cycle — checker's cycle path rules that out). Verdict: workflow accepted. BLOCKER (exact): L93 do-grammar proposal has no T01 root — unresolved proposal, needs T23-scope/T36 adjudication. (L93 role-revocation note: no ledger root either — same blocker.)

### 23. CanHire.can — `app CanHire uses=[hire]` + L5 `app PeopleDevelopment`

- Intent: recruit location staff; L5 composes PeopleDevelopment from
  CanHire/CanOnboard/CanLearn.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b); UNRESOLVED PROPOSAL: L333 catalog binding (no ledger root — blocker).
- Observations: `-> error(` x17 (rule_failed=11, forbidden=6); `do` blocks x1.
  (Fixture named `proposed` is Interview-domain language.)
- Proposal markers: L333 `##` "Static pipeline legend; per-stage highlight of the
  current candidate is desired behavior pending a catalog selection binding
  (proposed)."
- Unavailable-implementation markers: catalog selection binding for per-stage
  highlight, per L333 (direct evidence: comment text).
- Runtime negatives: 17 retained, never erased.
- T01: R11(b,T12/T13) L13 std (1 of 24). Verdict: workflow accepted. BLOCKER (exact): L333 catalog-selection binding desired-pending-proposed is ledger-silent — needs adjudication (owner TBD, not guessed); do x1 grammar status unadjudicated (run-wide caveat).

### 24. CanInbox.can — `app CanInbox uses=[inbox]`

- Intent: classify departmental email, review queue transfers, send evidenced replies.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b).
- Observations: `-> error(` x19 (rule_failed=16, forbidden=3); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 19 retained, never erased.
- T01: R11(b,T12/T13) L10 std (1 of 24; high-conf missing production, medium per member — flip: member conflicts with actual owner). Verdict: workflow accepted; do x1 grammar status unadjudicated (run-wide caveat).

### 25. CanInvoice.can — `app CanInvoice uses=[invoice]` + L5 `app Finance`

- Intent: issue readable invoices for offices, desks, rooms, memberships, add-ons;
  L5 composes Finance from CanInvoice/CanExpense/CanPurchase/CanReport.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R11/R14/R28 (b); unresolved scalar note L921 (no ledger root — minor blocker).
- Observations: `-> error(` x56 (rule_failed=40, forbidden=13, conflict=3);
  `do` blocks x1.
- Proposal markers: L921 `##` "proposed: email as input's "appropriate scalar";
  checker confirms."
- Unavailable-implementation markers: none directly evidenced (scalar proposal is a
  checker-confirmation note, not a stated absence; T01 to adjudicate).
- Runtime negatives: 56 retained, never erased.
- T01: R11(b,T12/T13) L13 std; R14(b,T28→T29) L58 Customer containment (named site; gated on T28 JEV); R28(b,T05) L739-742 else-branch query domain (medium; flip: element genuinely nullable or `?` is element nullability). Verdict: workflow accepted. BLOCKER (exact): L921 scalar "appropriate scalar" note unadjudicated — ledger has no scalar-appropriateness root; do x1 likewise unadjudicated (run-wide caveat).

### 26. CanKnowledge.can — `app CanKnowledge uses=[knowledge]`

- Intent: publish reviewed procedures; answer private questions with current evidence.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b).
- Observations: `-> error(` x18 (rule_failed=12, forbidden=6); `do` blocks x4.
  ("Propose revision" is a scenario label — domain language.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 18 retained, never erased.
- T01: R11(b,T12/T13) L7 std (1 of 24; high-conf missing production, medium per member — flip: member conflicts with actual owner). Verdict: workflow accepted; do x4 grammar status unadjudicated (run-wide caveat).

### 27. CanLearn.can — `app CanLearn uses=[learn]`

- Intent: text-based staff induction, safety procedures, member orientation.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x7 (rule_failed=6, forbidden=1); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 7 retained, never erased.
- T01: no ledger sites in this file (sampled; absence ≠ clean bill). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Learn — per-site attribution deferred to T02/T41; do x1 grammar status unadjudicated (run-wide caveat). Run-wide unavailable: T21-T23.

### 28. CanLeave.can — `app CanLeave uses=[leave]`

- Intent: staff request time off; managers see absences and plan coverage.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R12/R14 (+R07-class via R30) (b); example-attribution rule R29 (c, low-conf — blocker).
- Observations: `-> error(` x7 (rule_failed=6, forbidden=1); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 7 retained, never erased.
- T01: R12(b,T13/T14) L131 StaffSchedule.reserve opacity; R14(b,T28→T29) L22 containment (named; T28-gated); R30 method note: L131 converges R07-class E2013 (T08) + R12-class E3015/E2001 — fixing one root leaves others failing; R29(c,T23+T36) L136 input-vs-observation attribution (low; flip: adopted emitted-example contract allows/forbids input-alias observations). Verdict: workflow accepted. BLOCKER: T23 example semantics undecided; do x1 unadjudicated (run-wide caveat).

### 29. CanLoyalty.can — `app CanLoyalty uses=[loyalty]`

- Intent: reward repeat paid visits with points, tiers, fulfillable perks.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b).
- Observations: `-> error(` x22 (rule_failed=16, forbidden=4, conflict=1,
  validation=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 22 retained, never erased.
- T01: R11(b,T12/T13) L9 std (1 of 24; high-conf missing production, medium per member — flip: member conflicts with actual owner). Verdict: workflow accepted.

### 30. CanMail.can — `app CanMail uses=[mailroom]`

- Intent: receive/deliver customer mail and parcels for on-site/virtual customers.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R11/R23 (b); draft defect R20-family (a).
- Observations: `-> error(` x27 (rule_failed=24, forbidden=3); `do` blocks x1.
  ("future service availability" is domain language.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 27 retained, never erased.
- T01: R11(b,T12/T13) L11 std; R23(b,T35) L143/152 Contact.update/delete not enabled (medium; flip: owner contract shows disabled → a); R20-family(a,T36) L74 fixture cycle (same family as Grant:70 primary). Verdict: workflow accepted; do x1 grammar status unadjudicated (run-wide caveat).

### 31. CanMaintain.can — `app CanMaintain uses=[maintain]` + L5 `app Facilities`

- Intent: move facility faults through repair and return to service; L5 composes
  Facilities from CanMaintain/CanField/CanStock.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b).
- Observations: `-> error(` x20 (rule_failed=13, forbidden=6, conflict=1);
  `do` blocks x3.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 20 retained, never erased.
- T01: R11(b,T12/T13) L13 std (1 of 24; high-conf missing production, medium per member — flip: member conflicts with actual owner). Verdict: workflow accepted; do x3 grammar status unadjudicated (run-wide caveat).

### 32. CanMember.can — `app CanMember uses=[member_plans,member_terms,member_content,rent_fulfillment,invoice,desk,events]`

- Intent: manage paid membership terms and a customer member portal.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b).
- Observations: `-> error(` x11 (rule_failed=10, not_found=1); `do` blocks x2.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 11 retained, never erased.
- T01: R11(b,T12/T13) L77 std (1 of 24; high-conf missing production, medium per member — flip: member conflicts with actual owner). Verdict: workflow accepted; do x2 grammar status unadjudicated (run-wide caveat).

### 33. CanOnboard.can — `app CanOnboard uses=[employee,onboard]`

- Intent: HR/location managers prepare new employees for their duties.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defect R14 (b, JEV-gated).
- Observations: `-> error(` x11 (rule_failed=9, forbidden=2); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 11 retained, never erased.
- T01: R14(b,T28→T29) L15 containment (named site; medium; gated on T28 JEV decision — flip: demonstrated unenforceable unsafety + concise alternative). Verdict: workflow accepted; do x1 grammar status unadjudicated (run-wide caveat).

### 34. CanPropose.can — `app CanPropose uses=[propose]`

- Intent: sales teams quote offices, meeting rooms, coworking days, add-on services.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R14/R24 (b).
- Observations: `-> error(` x24 (rule_failed=17, forbidden=5, conflict=2);
  `do` blocks x1. (Proposal/Revision are the app's own domain models.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 24 retained, never erased.
- T01: R14(b,T28→T29) L40 containment (named site; T28-gated); R24(b,T35) L253 payload `version` (primary site; medium; flip: observed field proves runtime metadata → a). Verdict: workflow accepted; do x1 grammar status unadjudicated (run-wide caveat).

### 35. CanPurchase.can — `app CanPurchase uses=[supplier,purchase]`

- Intent: authorize furniture, supplies, repairs, spending against budgets.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b).
- Observations: `-> error(` x44 (rule_failed=33, forbidden=10, conflict=1);
  `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 44 retained, never erased.
- T01: R11(b,T12/T13) L11 std (1 of 24; high-conf missing production, medium per member — flip: member conflicts with actual owner). Verdict: workflow accepted.

### 36. CanReception.can — `app CanReception uses=[reception]`

- Intent: register visitors, check arrivals/departures, track keys/cards.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R11/R14 (b).
- Observations: `-> error(` x11 (rule_failed=8, forbidden=3); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 11 retained, never erased.
- T01: R11(b,T12/T13) L9 std; R14(b,T28→T29) L40 Location containment (named site; T28-gated). Verdict: workflow accepted; do x1 grammar status unadjudicated (run-wide caveat).

### 37. CanRefer.can — `app CanRefer uses=[refer]` + L5 `app ReferralsPartners`

- Intent: members/advocates earn fixed cash rewards for qualifying new customers;
  L5 composes ReferralsPartners from CanRefer/CanAffiliate.
- Disposition: ACCEPTED-WORKFLOW-INTENT — leaning draft defect R21 (a); no b-roots sampled.
- Observations: `-> error(` x14 (rule_failed=11, forbidden=3); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 14 retained, never erased.
- T01: R21(a-leaning,T36) L65 `join` scenario vs closed builtin (low-medium; flip: adopted namespace-separation rule, or second same-name use proving systematic intent). Verdict: workflow accepted; no source defects sampled (absence ≠ clean bill; T02/T41 re-attribution may add).

### 38. CanRent.can — `app CanRent uses=[rent_catalog,rent_catalog_ui,rent_reservations,rent_fulfillment,rent_reporting]` + L5 `app Workspace`

- Intent: authoritative booking app for desks, day offices, meeting rooms, event
  spaces; L5 composes Workspace from CanRent/CanMember/CanReport.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b); UNRESOLVED scalar proposals x5 (no ledger root — blocker).
- Observations: `-> error(` x26 (rule_failed=20, forbidden=5, conflict=1);
  `do` blocks x0. (`sequence` is a policy/evidence field name — domain language.)
- Proposal markers: five `##` "proposed: <scalar> as input's "appropriate scalar";
  checker confirms." at L1503 (money), L1515 (money), L1595 (email), L1649 (int),
  L1800 (money).
- Unavailable-implementation markers: none directly evidenced (scalar proposals are
  checker-confirmation notes, not stated absences; T01 to adjudicate).
- Runtime negatives: 26 retained, never erased.
- T01: R11(b,T12/T13) L80 std (1 of 24). Verdict: workflow accepted. BLOCKER (exact): L1503/L1515/L1595/L1649/L1800 "proposed: scalar as appropriate scalar; checker confirms" notes unadjudicated — ledger has no scalar-appropriateness root; needs adjudication (not guessed).

### 39. CanReport.can — `app CanReport uses=[report]`

- Intent: scoped operational reporting package for managers and finance.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defect R24 (b); draft defect R20-family (a).
- Observations: `-> error(` x2 (forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 2 retained, never erased.
- T01: R20-family(a,T36) L38 fixture cycle (same family as Grant:70 primary); R24(b,T35) L110 payload `parent` vs reserved metadata (medium; flip: proves runtime metadata → a). Verdict: workflow accepted.

### 40. CanShift.can — `app CanShift uses=[shift]` + L5 `app StaffScheduling`

- Intent: roster reception/community/sales/facilities staff; arrange replacements;
  L5 composes StaffScheduling from CanLeave/CanShift.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defect R11 (b); draft defect R20-family (a); UNADOPTED PROPOSAL R19 (d) — fanout unavailable.
- Observations: `-> error(` x14 (rule_failed=12, forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: `each=` fanout at L237
  (`scenario review_commitment on=EligibilityReview each=Commitment as commitment`)
  and L243 (`scenario review_swap on=EligibilityReview each=Swap as swap`).
  Plan confirms `each=` unadopted (Scoped-fanout section; T33/T34 own the decision).
- Runtime negatives: 14 retained, never erased.
- T01: R11(b,T12/T13) L12 std; R20-family(a,T36) L83 fixture cycle; R19(d,T33→T34) L237/L243 `each=` fanout (primary sites; medium; flip: continuation design with equal completeness/recovery at lower cost, or adopted finite durable fanout contract → b work). Verdict: workflow accepted; fanout implementation unavailable pending T33 JEV decision.

### 41. CanStats.can — `app CanStats uses=[stats]`

- Intent: marketing teams understand traffic and tracked inquiries on pages.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x6 (rule_failed=5, forbidden=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 6 retained, never erased.
- T01: no ledger sites in this file (sampled; absence ≠ clean bill). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Stats — per-site attribution deferred to T02/T41. Run-wide unavailable: T21-T23.

### 42. CanStock.can — `app CanStock uses=[stock]`

- Intent: track consumables by location and storeroom.
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b).
- Observations: `-> error(` x4 (rule_failed=3, forbidden=1); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 4 retained, never erased.
- T01: R11(b,T12/T13) L9 std (1 of 24; high-conf missing production, medium per member — flip: member conflicts with actual owner). Verdict: workflow accepted.

### 43. CanSuccess.can — `app CanSuccess uses=[success]`

- Intent: account managers retain business customers (move-in, reviews, renewals).
- Disposition: ACCEPTED-WORKFLOW-INTENT — single source defect R11 (b).
- Observations: `-> error(` x4 (rule_failed=2, forbidden=2); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 4 retained, never erased.
- T01: R11(b,T12/T13) L11 std (1 of 24; high-conf missing production, medium per member — flip: member conflicts with actual owner). Verdict: workflow accepted.

### 44. CanSync.can — `app CanSync uses=[sync]`

- Intent: review bounded CRM corrections; preserve remote edits, uncertain evidence.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x13 (rule_failed=9, forbidden=4); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 13 retained, never erased.
- T01: no ledger sites in this file (sampled; absence ≠ clean bill). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Sync — per-site attribution deferred to T02/T41; do x1 grammar status unadjudicated (run-wide caveat). Run-wide unavailable: T21-T23.

### 45. CanTable.can — `app CanTable uses=[cafe]`

- Intent: reception/cafe staff seat guests at an on-site workspace cafe/restaurant.
- Disposition: WORKFLOW-INTENT ACCEPTED on zero negative evidence — capability UNADJUDICATED (E5001 deferred — blocker).
- Observations: `-> error(` x24 (rule_failed=16, forbidden=7, conflict=1);
  `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 24 retained, never erased.
- T01: no R01-R30 root cites Table; ledger family coverage explicitly defers E5001 (2 diagnostics, Table:59) to T02/T41 with no verdict. Verdict: workflow intent accepted (no evidence against it). Exact blocker: E5001 unattributed — needs T02/T41 sampling. No whole-file negative. Run-wide unavailable: T21-T23.

### 46. CanTime.can — `app CanTime uses=[time]`

- Intent: teams record time on customer services, facilities work, projects.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x12 (rule_failed=9, forbidden=3); `do` blocks x1.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 12 retained, never erased.
- T01: no ledger sites in this file (sampled; absence ≠ clean bill). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Time — per-site attribution deferred to T02/T41; do x1 grammar status unadjudicated (run-wide caveat). Run-wide unavailable: T21-T23.

### 47. CanTrade.can — `app CanTrade uses=[trade]`

- Intent: members advertise services, request suppliers, offer surplus equipment.
- Disposition: ACCEPTED-WORKFLOW-INTENT (no sampled defects, no whole-file negative) — capability blockers UNADJUDICATED (blocker below).
- Observations: `-> error(` x12 (rule_failed=7, forbidden=4, conflict=1);
  `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 12 retained, never erased.
- T01: no ledger sites in this file (sampled; absence ≠ clean bill). Verdict: workflow intent accepted. Exact blocker: no R01-R30 root cites Trade — per-site attribution deferred to T02/T41. Run-wide unavailable: T21-T23.

### 48. CanVolunteer.can — `app CanVolunteer uses=[volunteer]`

- Intent: community teams organize member volunteers for sessions/events/charity.
- Disposition: ACCEPTED-WORKFLOW-INTENT — UNADOPTED PROPOSAL R19 (d) only; no b-roots sampled; fanout unavailable.
- Observations: `-> error(` x13 (rule_failed=10, forbidden=3); `do` blocks x0.
- Proposal markers: none observed.
- Unavailable-implementation markers: `each=` fanout at L47
  (`scenario refresh_reminders on=Opportunity.updated each=Signup as signup`) and
  L178 (`scenario cancel_signup on=OpportunityCancelled
  each=event.opportunity.Signup as signup`). Plan confirms `each=` unadopted
  (Scoped-fanout section; T33/T34 own the decision).
- Runtime negatives: 13 retained, never erased.
- T01: R19(d,T33→T34) two Volunteer sites (L47/L178 per prep; ledger confirms "two Volunteer sites"; medium; flip: continuation design with equal completeness/recovery at lower cost, or adopted finite durable fanout contract → b work). Verdict: workflow accepted; fanout implementation unavailable pending T33 JEV decision; no source defects sampled (absence ≠ clean bill).

### 49. CanWorkbench.can — `app CanWorkbench uses=[workbench]`

- Intent: employees propose and explicitly approve bounded changes through owning
  business operations.
- Disposition: ACCEPTED-WORKFLOW-INTENT — source defects R11/R23 (b).
- Observations: `-> error(` x15 (rule_failed=15); `do` blocks x7 — most `do`
  blocks in the corpus after Expense. ("proposed" fixture/scenario names are
  workbench-domain language.)
- Proposal markers: none observed.
- Unavailable-implementation markers: none observed (beyond run-wide T21-T23 note).
- Runtime negatives: 15 retained, never erased.
- T01: R11(b,T12/T13) L6 std; R23(b,T35) L128 Task.update not enabled (medium; flip: owner contract shows disabled → a). Verdict: workflow accepted; do x7 grammar status unadjudicated (run-wide caveat — no parser-rejection comment in this file, unlike Approve/Expense/Grant).

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

## T02 reconciliation summary (T01 landed — read with the prep record above)

- Coverage: 49/49 dispositions reconciled against root-causes.md (R01-R30, C1-C7);
  zero placeholders remain. Verdicts: 48 ACCEPTED-WORKFLOW-INTENT,
  1 accepted-on-zero-negative-evidence with capability blocker (Table, E5001 deferred).
- Species counts (apps; one app may carry several): bucket-b source defects 35
  (of which R11-only single-root 13: Book/Decide/Gallery/Hire/Inbox/Knowledge/
  Loyalty/Maintain/Member/Purchase/Rent/Stock/Success); bucket-a draft defects 7
  (Grant R20 demonstrated; Mail/Report/Shift R20-family; CRM R22 + Event/Refer R21
  leaning); bucket-c open rules 5 (Affiliate R16/R18, Chat R26-layer2,
  Check R17, Creative R26-layer2, Leave R29); bucket-d unadopted proposals 2
  (Shift/Volunteer R19 fanout); ledger-silent capability blockers 12 (Board,
  Customer, Discover, Enrich, Feedback, Field, Learn, Stats, Sync, Time, Trade
  uncited + Table E5001-deferred); ledger-silent proposal blockers 6
  (Approve/Expense/Grant do-grammar, Hire L333 binding, Invoice L921 + Rent x5
  scalar notes). No bucket-e roots exist in the ledger.
- Run-wide caveat (do-grammar): the ledger contains no do-example-grammar root.
  25 files contain `do` blocks; only Approve/Expense/Grant carry explicit
  parser-rejection comments (recorded as unresolved proposals there). The other
  22 files' do-block grammar status is unadjudicated — exact blocker for
  T23-scope/T36 adjudication, not guessed per file.
- Run-wide caveat (unattributed ledger sites): R14 names 6 containment sites +
  "14 further sites" without files — those 14 are unattributed blockers, not
  assigned to any app here. E5004 trusted-handler `as` (2 diagnostics) is likewise
  file-unattributed in the ledger. E5001 (Table:59) is explicitly deferred to T02/T41.
- Run-wide unavailable implementation (plan ref, not T01): testkit loader no-op/
  unsupported invocation + e2e compiled-path rejection (T21-T23) still apply to all
  example-bearing apps.
- Runtime negatives: 830/830 retained, zero erased, zero reclassified (per-file
  counts untouched from prep).
- Whole-file negatives: 0 recorded — prep grep found no explicit whole-file
  compile-negative intent and the ledger supplies no whole-file verdict; none invented.
- Ledger bases used: c4a9775 + draft 2d67312 (T01 repro). No other path touched;
  no heavy commands run (read-only evidence task; verification greps only).
