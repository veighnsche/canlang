# T33 prep: scoped durable fanout — alternatives for the JEV gate

Status: **PROPOSED / PREP — adopts NOTHING.** Decision requires the
coordinator-run JEV protocol (three fresh, equivalent, independently worded
requests with saved advice/uncertainty) plus full-scope evidence. Every
alternative below carries explicit **JEV-PENDING** markers. No T34
implementation may begin before the gate accepts one rule; a scoped
disposition is explicitly deferred, never implemented, never ticked as done.

Scope note (T33 brief): define cohort/checkpoint/identity/concurrent-change/
failure/supersession semantics, adopted or explicitly scoped with complete
reasons. Done when the gate records adopt-vs-scope for each facet with costs.

## Settled context (read-only inputs, not decisions)

- R19 ([root-causes.md](root-causes.md)): E1203 x4 — `unsupported scenario
  attribute 'each'`. Bucket **d**; confidence medium; flip needs either a
  continuation design with equal completeness/recovery at lower cost, or an
  adopted finite durable fanout contract (then this becomes bucket-b work).
- The four `each=` sites use TWO cohort spellings:
  1. [CanShift.can](/Users/vince/Projects/canlang/draft/CanShift.can:237)
     `scenario review_commitment on=EligibilityReview each=Commitment as
     commitment` — bare-model cohort; body filters by nullable event keys
     (employee/location/account/roster, each null-or-match), then marks
     `conflict=true` and emits `ReservationOutcome{unavailable}` when the
     commitment is ineligible or a duty role mismatches.
  2. [CanShift.can](/Users/vince/Projects/canlang/draft/CanShift.can:243)
     `scenario review_swap on=EligibilityReview each=Swap as swap` —
     bare-model cohort; body navigates `swap.parent.parent` to the
     commitment, applies the same null-or-match filters plus a long
     invalidation predicate, then sets `state=obsolete`.
  3. [CanVolunteer.can](/Users/vince/Projects/canlang/draft/CanVolunteer.can:47)
     `scenario refresh_reminders on=Opportunity.updated each=Signup as
     signup` — bare-model cohort; body filters `signup.parent.id==event.id`,
     cancels the signup's pending schedule key, and re-arms a `Reminder`
     only for future confirmed signups with venue confirmed.
  4. [CanVolunteer.can](/Users/vince/Projects/canlang/draft/CanVolunteer.can:178)
     `scenario cancel_signup on=OpportunityCancelled
     each=event.opportunity.Signup as signup` — **parent-anchored**
     reverse-collection cohort; body checks `signup.parent.cancelled` and
     `state in [registered,confirmed]`, then sets `state=cancelled`,
     cancels the schedule key, and sends a guarded cancellation email.
- Bare-model cohorts (sites 1–3) enumerate a whole model and filter in-body;
  site 4 enumerates one parent's contained collection. Complete-enumeration
  cost differs sharply between these shapes (see Alternative D). The audit
  plan states: "an eventually updated owner directory is not proof of
  complete enumeration."
- Adjacent adopted machinery (DESIGN, read-only here): committed-event
  payloads are immutable identities and each handler gets an independent
  stable occurrence identity with receipt-replay on duplicate delivery
  (L520); recurring `every` fanout admits one independently admitted
  occurrence per extant eligible team with per-scope coalescing, while
  root-bound recurrence stays unsupported for lack of an authoritative
  coverage contract (L526); schedule replacement supersedes undispatched
  occurrences and dispatch atomically checks supersession plus the `when`
  guard before claiming provider work (L524); every external effect is a
  durable outbox item committed with its originating state with bounded
  retry, and Cloudflare Queues are at-least-once so outbox receipts plus
  current-state guards carry duplicate/reorder safety — no exactly-once
  promise (L566–568); batch confirmation submits each row as its own
  transaction with a stable per-row identity, reports outcomes separately,
  and reruns review before each row (L779); bounded exports capture a read
  checkpoint and must never label incomplete data complete (L769–771);
  migration `invalidate` reaches only undispatched pending occurrences and
  retains replay identity (L996); `queue Jobs type=Work` gives
  `send Jobs.publish` + `on=Jobs` typed delivery (L593, R13).
- Ordinary bounded-loop precedent: Shift:275 `for conflict in conflicts
  limit=100` stays the bounded in-transaction traversal form; R19 keeps the
  negative that ordinary bounded loops still reject overflow.
- App-intent dispositions: Shift and Volunteer are ACCEPTED-WORKFLOW-INTENT
  with R19 as the T33-gated blocker; all runtime negatives retained
  (Shift 14, Volunteer 13). T40 qualifies Shift/Volunteer only on adopted
  T34; without adoption they remain explicit gaps.
- T33 acceptance bar: explicit adopt-or-scope with reasons for
  cohort/checkpoint/identity/concurrent-change/failure/supersession plus
  costs; three equivalent JEV formulations saved and investigated; every
  required-but-unsupported fanout app remains blocked, never silently cut.

## Workflows each alternative must preserve (acceptance bar)

1. Shift eligibility sweep: one `EligibilityReview` reviews every in-scope
   `Commitment` (conflict marking + unavailable outcome) and every in-scope
   `Swap` (obsolete marking), honoring the null-or-match event filters.
2. Volunteer reminder refresh: one `Opportunity.updated` cancels and
   conditionally re-arms reminders for that opportunity's signups only.
3. Volunteer cancellation sweep: one `OpportunityCancelled` cancels each
   registered/confirmed signup of that opportunity and sends each guarded
   notice exactly once per signup (retry-safe).
4. Negatives (R19/T33): unsupported fanout spellings stay blocked with a
   diagnostic; partial execution is never reported as complete; ordinary
   bounded loops still reject overflow; no silent whole-model traversal
   where the cohort contract is unadopted.

## Alternative A — Durable checkpointed fanout with per-child occurrences

Rule: adopt a finite durable fanout contract for both cohort spellings.
Triggering commits a fanout intent with a frozen cohort cutoff; each member
becomes an independently admitted child occurrence with its own receipt and
bounded transaction; a durable checkpoint records completed children so
crash recovery resumes without re-executing them.

- Cohort/cutoff: membership is frozen at trigger commit (snapshot of
  matching record identities under the cohort expression — bare model or
  reverse collection). Late inserts do not join the in-flight fanout.
  Cohort-size bound is a declared deployment quota (**JEV-PENDING** value
  and overflow behavior: reject trigger vs admit-and-truncate-never).
- Identity: child identity = parent occurrence identity + stable record id.
  Duplicated trigger deliveries replay the parent receipt and mint no new
  children (L520 precedent).
- Checkpoint/admission atomicity: checkpoint advance commits in the same
  owner batch as each child's domain effects (L555 batch shape); a crash
  between children replays at most the un-checkpointed child.
- Concurrent change: insert/move/remove during flight follows the frozen
  cutoff for membership; per-child version guards (`signup.version`,
  `commitment.version` style, as the drafts already read) decide admission
  of each child against current state. A concurrently deleted child records
  a skipped outcome, not a failure (**JEV-PENDING**: skip-vs-fail).
- Child authority: each child evaluates its body (filters, `set`, `emit`,
  `send ... when`, `schedule`/`cancel`) under the trigger's verified
  context with ordinary admission; cross-owner children fail checking
  (L526 scope-family precedent).
- Failure/retry: one child's business rejection or terminal failure does
  not roll back siblings (L779 per-row precedent); transient runtime
  failures retry that child under its stable identity with the standard
  bounded-retry horizon. Outcomes are reported per child; partial
  completion is never labeled complete (L769 precedent).
- Supersession: a superseding trigger (or explicit cancel) marks
  undispatched children skipped; already-admitted or provider-accepted
  children run to reconciliation (L524/L996 precedent). Which trigger
  pairs supersede is declared per scenario (**JEV-PENDING** spelling).
- Migration: zero draft edits at the four sites; `each=` becomes a checked
  attribute with the cohort expression type-checked (model or contained
  collection only).
- Workflows preserved: all four bar items hold verbatim, including the
  in-body null-or-match filters (kept as defense-in-depth over the frozen
  cohort) and the exactly-once-per-signup notice via child receipt replay.
- Costs: new durable intent type + checkpoint table + recovery scan +
  per-child receipt correlation; T24 dispatch must stage fanout intents
  atomically with the trigger commit; T34 must prove 499/500/501/1000
  cohort completeness, crash resume, duplicate-trigger replay, concurrent
  insert/move/remove, rejected children, retry horizons, and supersession.
  Largest implementation cost of the four.
- Strongest opposing case: this builds a mini-workflow engine for four
  draft sites — checkpoint tables, recovery scans, and per-child receipts
  are heavy machinery whose failure modes (lost checkpoints, repeated
  children, misreported partial completion) are exactly the audit's
  worries; if real cohorts stay small, Alternative B proves the same
  workflows at a fraction of the cost. **JEV-PENDING**: whether any
  evidenced cohort needs cross-crash durability, and what the cohort-size
  bound should be.

## Alternative B — Single-transaction bounded fanout, no cross-child durability

Rule: adopt `each=` as in-transaction bounded iteration. The trigger and
all children commit atomically in one owner transaction; a hard cohort cap
keeps the transaction bounded; overflow rejects the trigger; a crash
retries the whole occurrence as one unit with receipt replay.

- Cohort/cutoff: membership evaluated live in the trigger transaction; no
  frozen cutoff beyond the transaction's own read snapshot. Hard cap, e.g.
  the `limit=100` order already used at Shift:275 (**JEV-PENDING** exact
  cap and whether per-scenario `limit=` overrides it).
- Identity: one occurrence identity for trigger + all children; no
  per-child receipts. Duplicate deliveries replay the single receipt.
- Checkpoint/admission atomicity: no checkpoint — atomicity IS the
  trigger transaction (L555 batch). Either every child commits or none do.
- Concurrent change: ordinary transaction conflict rules apply; a
  concurrent write to any touched row fails the whole fanout for retry.
  No insert/move/remove policy beyond snapshot isolation.
- Child authority: children run inline in the trigger's transaction and
  context; `send`/`schedule`/`emit` stage intents for post-commit dispatch
  exactly like today's bodies. Same-transaction `send ... when` guards
  evaluate once.
- Failure/retry: any child's business rejection fails the whole trigger
  (authored `require` semantics, L366); transient failure retries the
  whole occurrence. No per-child outcome reporting — success means all
  children committed.
- Supersession: only whole-occurrence supersession (L524): a superseding
  trigger skips the occurrence only if undispatched; once admitted, it
  runs to completion.
- Migration: zero draft edits if all real cohorts fit the cap; any
  over-cap scenario stays rejected with an overflow diagnostic until
  remodeled.
- Workflows preserved: bar items 1–4 hold only for cohorts within the cap
  — Volunteer reminder/cancel sweeps (per-opportunity signups) plausibly
  fit; Shift whole-model sweeps fit only if `Commitment`/`Swap` populations
  stay small (**JEV-PENDING**: no draft evidence pins real cohort sizes).
  Atomicity changes observable behavior vs A: no partial completion exists.
- Costs: checker + codegen work only; no checkpoint storage, no recovery
  scan, no per-child receipts; T24 join is the ordinary already-planned
  outbox staging. T34 proof burden shrinks to cap enforcement, overflow
  rejection, duplicate-trigger replay, and conflict retry. Cheapest
  adoption; cost is the cap itself.
- Strongest opposing case: all-or-nothing over a whole model is a
  transaction-size hazard — one contested row aborts a 1000-child sweep,
  retry storms follow, and the cap that saves the engine strands the very
  Shift sweeps the drafts wrote as whole-model traversals; authors will
  bump `limit=` until the bound is fiction. **JEV-PENDING**: whether the
  Shift bare-model sweeps fit any defensible cap, and whether whole-sweep
  atomicity matches draft intent (nothing in the drafts pins atomic vs
  per-child outcomes).

## Alternative C — No fanout primitive; continuation/query-driven traversal

Rule: keep `each=` rejected (E1203 retained). Authors express traversal
with existing bounded forms — explicit queries plus per-record operations
or bounded `for limit=` loops — and completeness rides on ordinary
per-operation receipts. The T33 decision is an explicit scoping of fanout
as a language feature, with a supported remodeling idiom.

- Cohort/cutoff: no language cohort concept; each remodeling query states
  its own filter (e.g. `Commitment as c where ...`), evaluated per
  execution under ordinary read-fence rules (T32-gated).
- Identity: ordinary per-operation identities only; no parent/child
  correlation beyond what authors pass as explicit arguments.
- Checkpoint/admission atomicity: none provided; multi-step sweeps are
  separate operations with separate receipts, like any sequence of calls.
- Concurrent change: no membership policy; records inserted mid-sweep may
  or may not be visited depending on query timing (**JEV-PENDING**:
  whether that is acceptable for eligibility sweeps).
- Child authority: each step is an ordinary operation with ordinary
  admission — no new authority surface at all.
- Failure/retry: per-operation behavior only; a mid-sweep failure leaves
  earlier steps committed with no sweep-level outcome record.
- Supersession: no sweep-level supersession; authors re-run or guard
  idempotently per record.
- Migration: all four sites remodeled under T36/draft-owner adjudication
  to explicit query + bounded-loop/send forms; each needs demonstrated
  equivalence (filter parity for the null-or-match guards, `parent.parent`
  navigation, schedule-key cancel/re-arm pairing, guarded-notice
  exactly-once per signup). Highest authoring and proof burden; pressures
  the no-blanket-rewrite rule at four sites.
- Workflows preserved: achievable in principle for small cohorts, but
  preservation must be re-proven site by site — eligibility-sweep coverage,
  reminder re-arm pairing, and per-signup notice uniqueness each need a
  witness. No completeness proof obligation exists (nothing to prove
  against), which is both the attraction and the risk.
- Costs: zero language/runtime cost; maximum per-site migration and review
  cost; every future sweep repeats it; T34 becomes a scoping record, not
  an implementation task.
- Strongest opposing case: it answers a completeness problem by deleting
  the completeness obligation — mid-sweep inserts silently missed,
  mid-sweep failures silently partial, and the drafts' plain traversal
  intent ("review every commitment on eligibility change") rewritten into
  verbose query plumbing; the R19 flip burden demands a continuation
  design with EQUAL completeness/recovery, not merely fewer features.
  **JEV-PENDING**: whether the remodeling idiom can demonstrate equal
  completeness/recovery at lower total cost, and whether four-site
  migration violates minimal-intervention.

## Alternative D — Adopt parent-anchored cohorts only; bare-model stays blocked

Rule: adopt the Alternative-A durable machinery but scope the cohort
language to parent-anchored collections (`event.opportunity.Signup` and
equivalents). Bare-model traversals (`each=Commitment`, `each=Swap`,
`each=Signup`) keep E1203 until an authoritative whole-model coverage
contract exists. This is partial adoption with an explicit deferred remainder.

- Cohort/cutoff: only contained-collection cohorts whose parent record is
  pinned by the trigger event; cutoff freezes that collection's membership
  at trigger commit. Bare-model cohorts are a checking error pointing at
  the scoping decision.
- Identity/checkpoint/concurrent-change/authority/failure/supersession: as
  Alternative A within each adopted cohort; per-child receipts, frozen
  cutoff, version-guarded admission, per-child retry, undispatched-only
  supersession.
- Migration: Volunteer site 4 (`each=event.opportunity.Signup`) checks
  unchanged. Shift sites 1–2 and Volunteer site 3 (bare-model) must be
  remodeled to parent-anchored traversals where the workflow allows
  (Volunteer site 3's `signup.parent.id==event.id` filter is already a
  parent-anchored sweep in disguise — **JEV-PENDING** whether that
  remodeling is faithful) or stay blocked with a diagnostic where it does
  not (Shift whole-model eligibility sweeps have no single anchoring
  parent — **JEV-PENDING** whether per-roster/per-location anchoring
  preserves the workflow).
- Workflows preserved: bar item 3 (cancellation sweep) holds verbatim; bar
  item 2 holds after faithful remodeling; bar item 1 holds only if Shift
  sweeps can be anchored without changing coverage — otherwise Shift
  fanout stays an explicit gap under T40 while Volunteer ships.
- Cycle/lifecycle: contained-collection enumeration composes with the
  accepted local-containment lifecycle (archive/delete subtree rules);
  no whole-model directory coverage promise is ever made — the exact gap
  the audit plan flags.
- Costs: same machinery as A (checkpoint, recovery, per-child receipts)
  but T34 proof burden covers only anchored cohorts; bare-model
  completeness proof (499/500/501/1000 over a whole model with concurrent
  insert/move/remove) is deferred, not owed. Adds a two-tier cohort
  language that must be taught and diagnosed.
- Strongest opposing case: it ships the machinery while stranding the
  harder half of the workflows — Shift's eligibility sweeps, the primary
  R19 sites, stay blocked, so the project pays Alternative-A costs for
  Alternative-C outcomes on the flagship workflow; and the anchored/bare
  split is subtle enough that authors will read it as arbitrary checker
  strictness. **JEV-PENDING**: whether Shift sweeps admit faithful
  parent-anchored remodeling, and whether partial adoption beats
  waiting for full coverage.

## Fairness record (preserved opposing cases)

- A's risk: mini-workflow-engine machinery (checkpoints, recovery scans,
  per-child receipts) for four sites, carrying exactly the
  lost-checkpoint/repeated-child/misreported-partial failure modes the
  audit fears (R19 opposing, this file).
- B's risk: whole-sweep atomicity over a whole model — transaction-size
  hazard, retry storms, and a cap that strands the Shift sweeps it was
  meant to serve.
- C's risk: completeness obligation deleted rather than met; silent
  mid-sweep misses and partial sweeps; maximum migration cost to preserve
  a checker limitation rather than a semantic necessity (R19 flip burden).
- D's risk: full machinery cost for partial workflow coverage; Shift, the
  primary R19 workflow, potentially still blocked behind a subtle
  anchored/bare distinction.
- Cost ordering by implementation spend: C < B < D ≈ A; by workflow
  coverage if adopted: C < D ≤ B < A (B's coverage collapses above its
  cap). No alternative is ranked or adopted here. Ranking is the JEV
  gate's job.

## What the gate still needs (evidence checklist)

1. T24 dispatch evidence: atomic trigger-commit/outbox-staging shape and
   recovery-scan behavior that A/D fanout intents would ride on (T24
   pending — applicable slices must land before the gate can accept A/D).
   **[GATE-COMPLETE 2026-10-06: T24 TICKED COMPLETE — landed shape
   transcribed in "T33 gate-input refresh" §R1; fanout-specific substrate
   still T34-owed and remainders recorded there, adopts nothing.]**
2. T28 ownership input: `swap.parent.parent` navigation (Shift:245),
   `event.opportunity.Signup` reverse collection (Volunteer:178), and any
   imported-containment facets the cohort language may traverse (T28
   pending — gate needs at least the ownership rule for locally contained
   cohort parents).
3. T32 read-fence input: child bodies re-read current state (version
   guards, `eligible()`, `can_work()`); per-child staleness/revocation
   boundaries come from the accepted T32a rule (T32a prep done, gate
   pending).
   **[GATE-COMPLETE 2026-10-06: T32a ADOPTED checkpoint_fence A +
   T32b fence+wire LANDED — rule + wired boundaries transcribed in
   "T33 gate-input refresh" §R3; standing obligations recorded there,
   adopts nothing.]**
4. Cohort-cutoff intent: no draft example pins snapshot-vs-live membership
   or concurrent insert/move/remove handling for any of the four sites;
   absence must be confirmed by re-reading the surrounding scenarios, not
   assumed. **[GATE-COMPLETE 2026-10-05: absence CONFIRMED by re-read —
   see "Intent absence confirmation (gate evidence)" §A; adjacent
   per-child intent reported exactly in §C, adopts nothing.]**
5. Supersession intent: no draft example pins re-trigger-during-flight for
   any fanout scenario; confirm absence; if absent, the gate picks the
   default (L524 undispatched-only vs whole-occurrence) without draft
   grounding. **[GATE-COMPLETE 2026-10-05: absence CONFIRMED by re-read —
   see "Intent absence confirmation (gate evidence)" §B; gate picks the
   default without draft grounding.]**
6. Size evidence: no draft cohort approaches 499+ records; the
   499/500/501/1000 completeness sizes are proof obligations from the
   audit plan, not observed needs — record that explicitly so the gate
   does not mistake proof sizes for requirements evidence.
7. Shift anchoring analysis for D: can the EligibilityReview sweeps be
   faithfully remodeled per-roster/per-location/per-employee, or does the
   null-or-match broadcast filter require whole-model coverage?
8. Syntax-after-guarantees ordering (audit plan): the gate compares `each=`
   spellings only after the completeness contract is concrete; no syntax
   vote precedes the semantics decision.
9. Coordinator-run JEV protocol: three fresh equivalent independently
   worded formulations, saved responses + uncertainty, disagreement
   investigated. **No JEV was run for this prep file; tools/jev.py
   untouched.**
10. T34 proof plan for the adopted alternative (or scoping record with
    deferred reasons for C / the bare-model remainder of D): sizes,
    crash/duplicates/concurrent-change/rejected-child/retry/supersession
    witnesses, and the T40 per-app qualification consequences.

## Handoff

- Writer: L4 T33-prep. Single new file; work/contracts code untouched
  (T34 is post-gate); DESIGN.md/GRAMMAR.md/DECISIONS.md untouched
  (read-only); tasks.md/monitor.md/inbox untouched (coordinator-owned);
  no JEV run; no Git.
- Release: this file is RELEASED to the coordinator for gate scheduling.

## Intent absence confirmation (gate evidence)

Writer: L4 T33-absence-confirm (append-only slice; prep alternatives,
fairness record, and checklist text above untouched except the items 4–5
markers). Status: **PREP — adopts NOTHING.** Read-only inspection only;
no builds, no JEV, no Git.

Census re-verified: exactly four `each=` sites exist in `draft/`
(`rg -n "each=" draft/` returns only the four lines below, nothing else).

### Per-site verdicts

**Q1 = snapshot-vs-live membership pinned? Q2 = concurrent
insert/move/remove handling pinned? Q3 = re-trigger-during-flight pinned?**

**Site 1 — Shift `review_commitment`
([CanShift.can](/Users/vince/Projects/canlang/draft/CanShift.can:237),
body L237–242): Q1 NO, Q2 NO, Q3 NO.**
Read range establishing absence: `draft/CanShift.can:211-252`
(`recover_commitment` with its examples at L221–225, all five
EligibilityReview emitters at L226–236, both `each=` scenarios at
L237–248, `duty_notice` at L249–252) plus the event declaration at
`draft/CanShift.can:49`
(`event EligibilityReview { employee:Employee?, location:text?,
account:user?, roster:Roster? }`). The scenario body filters by
nullable event keys, marks `conflict=true`, and emits
`ReservationOutcome{unavailable}`; it contains no membership-timing,
concurrency, or re-trigger text. No `examples` block is attached to
this scenario (next `examples` after L237 belongs to
`reserve_connected` at L278). Keyword census over both draft files for
`snapshot|concurrent|supersed|re-trigger|retrigger|cutoff|frozen`
returns zero hits in these two files.

**Site 2 — Shift `review_swap`
([CanShift.can](/Users/vince/Projects/canlang/draft/CanShift.can:243),
body L243–248): Q1 NO, Q2 NO, Q3 NO.**
Same read range as site 1 (`draft/CanShift.can:211-252` + `:49`). The
body reads `commitment.version!=swap.revision` (L247) — a per-child
staleness check evaluated inside one child's invalidation predicate,
not a cohort-membership or mid-flight insert/move/remove policy. No
`examples` block is attached (nothing between L243 and `duty_notice`
at L249). Note: `Swap.state` enum labels `obsolete` as "Superseded"
(`draft/CanShift.can:47`) — a display caption for a per-record state
value, not a re-trigger-during-flight rule.

**Site 3 — Volunteer `refresh_reminders`
([CanVolunteer.can](/Users/vince/Projects/canlang/draft/CanVolunteer.can:47),
body L47–52): Q1 NO, Q2 NO, Q3 NO.**
Read range establishing absence: `draft/CanVolunteer.can:41-80`
(`venue_on_create`, the scenario, `publish`, `signup`, `confirm`,
`withdraw` with its examples at L76–80). The body filters
`signup.parent.id==event.id`, cancels the schedule key, and re-arms a
`Reminder` carrying `revision=signup.version` (L52) — schedule-key
pairing, not a membership policy. No `examples` block is attached
(L53 is the next scenario's comment). Companion absence statement, see
§C.

**Site 4 — Volunteer `cancel_signup`
([CanVolunteer.can](/Users/vince/Projects/canlang/draft/CanVolunteer.can:178),
body L178–185): Q1 NO, Q2 NO, Q3 NO.**
Read range establishing absence: `draft/CanVolunteer.can:157-197`
(`venue_changed`, `cancel` emitting `OpportunityCancelled` at L173–177,
the scenario, `remind` with its examples at L193–197). The body's
`when=signup.version==signup_revision and ...` send guard (L184) is
per-child dispatch fencing, not a membership or re-trigger policy. No
`examples` block is attached (L186 starts `remind`). Companion absence
statement, see §C.

### §A — Item 4 (cohort-cutoff): absence confirmed

No `.can` scenario body, attached example, or surrounding scenario in
the read ranges above pins snapshot-vs-live membership or concurrent
insert/move/remove handling for any of the four sites. The desired
targets corroborate structurally: all four `.mjs` handlers are
per-child functions receiving an already-selected child
(`refresh_reminders(c, { event, signup })` at
`draft/CanVolunteer.mjs:704`; `cancel_signup(c, { event, signup })` at
`draft/CanVolunteer.mjs:1057`; `review_commitment(c, { event,
commitment })` at `draft/CanShift.mjs:1315`; `review_swap(c, { event,
swap })` at `draft/CanShift.mjs:1333`), and the `each:` declarations
carry routing metadata only (model + bind, plus a parent resolver for
site 4 at `draft/CanVolunteer.mjs:629-636`) — no dispatcher loop, no
membership-timing or concurrency semantics exist anywhere in either
`.mjs` file (`rg` for `each|fanout|cohort|for (` returns only the four
`each:` declaration lines). Per RQ04 the `.mjs` is desired output, not
proof; it is cited here only as absence corroboration, and it pins
nothing either way.

### §B — Item 5 (supersession): absence confirmed

No draft text at or around any of the four sites addresses a second
trigger arriving while a fanout is in flight (second EligibilityReview
during a Shift sweep; second Opportunity.updated/OpportunityCancelled
during a Volunteer sweep). The only "supersed*" occurrences touching
these workflows are the `Swap.state.obsolete` "Superseded" display
caption (site 2, per-record state, quoted above) and the CanMaintain /
CanTime / CanGrant usages, which belong to unrelated apps. Per the
checklist, the gate therefore picks the re-trigger default (L524
undispatched-only vs whole-occurrence) without draft grounding.

### §C — Adjacent intent evidence (reported exactly; pins NEITHER item 4 nor 5)

The requirements companions pin per-child semantics around the fanout
sites. This evidence is reported exactly because the brief requires it;
it does NOT answer Q1–Q3 (no sentence addresses late-join membership,
mid-flight insert/move/remove, or re-trigger), and it is NOT adopted.

- `draft/CanShift.md:81` (sites 1–2): "Two review handlers then
  enumerate the finite admitted cohort — every Commitment identity for
  review_commitment, every Swap identity for review_swap — and recheck
  each record against current state when its child executes" … "Cohort
  size is not a capacity rule: 499, 500, 501 and 1,000 admitted
  identities all belong to the same complete contract, and the old
  rejecting 500-row transaction bounds are gone." … "a failed child
  does not stop other children, and a fully scanned run with failed
  children reports attention, never successful completion." …
  "commitment and swap children are correct in either order" …
  "previously committed conflict or obsolete decisions remain sticky
  and are not automatically cleared." … "Historical commitments stay
  outside effective flagging scans."
- `draft/CanShift.md:87` (sites 1–2): "per-child review cases await
  specified handler-fixture binding, so no invented each example
  selectors are authored." (Explicit statement that per-child examples
  are absent.)
- `draft/CanVolunteer.md:73` (site 4): "Cancelling sets parent truth
  immediately and emits OpportunityCancelled with the captured reason;
  each signup child then stores cancelled and one guarded notice
  intent." … "Parent cancellation success means the activity is
  cancelled and its durable trigger committed, not that every child
  already ran; operator progress must expose remaining/failed children,
  and a failed child never makes the parent usable again."
- `draft/CanVolunteer.md:75` (site 3): "the committed refresh pass
  replaces each keyed pending reminder from current parent and signup
  versions and current eligibility, and can never re-arm a cancelled
  parent or overwrite a signup state."
- `draft/CanVolunteer.md:77` (sites 3–4): "No per-child example cases
  are authored for cancel_signup or refresh_reminders: individual child
  business cases await specified handler-fixture binding, and cohort
  sizes, crashes, fresh reads, interleavings and dispatcher fairness
  need shared-runtime fixtures, so no invented each selectors are
  authored." (Explicit statement deferring exactly the item-4/item-5
  subject matter — fresh reads, interleavings — to shared-runtime
  fixtures.)

### Alternatives discrimination

- The §C evidence discriminates against Alternative B (single
  atomic transaction + hard cap): Shift.md:81's no-cap rule
  ("499, 500, 501 and 1,000 … the old rejecting 500-row transaction
  bounds are gone") contradicts B's cap; its per-child failure
  isolation ("a failed child does not stop other children … reports
  attention, never successful completion") contradicts B's
  all-or-nothing atomicity; Volunteer.md:73's durable-trigger-committed
  with children running after ("not that every child already ran" +
  "operator progress must expose remaining/failed children")
  contradicts B's "success means all children committed." This input
  favors A/D-shaped per-child execution over B — recorded for the
  gate, adopted by nothing here.
- The confirmed absences (§A/§B) discriminate among NO alternatives:
  with no draft grounding for snapshot-vs-live, concurrent-change, or
  re-trigger policy, the gate must pick each default on engineering
  grounds (A/D frozen-cutoff vs B live-transaction vs C per-query
  timing; skip-vs-fail for deleted children; L524 undispatched-only vs
  whole-occurrence supersession).
- Alternative C (remodeling) and Alternative D's Shift-anchoring
  question (checklist item 7) are unaffected by these findings.

### Commands run

1. `rg -n "EligibilityReview|each=|snapshot|concurrent|supersed|re-trigger|retrigger|cutoff|frozen" draft/CanShift.can draft/CanVolunteer.can` — four `each=` lines + six EligibilityReview lines; zero snapshot/concurrency/retrigger hits.
2. `rg -n "each=" draft/` — census: exactly the four known sites, nothing else.
3. `rg -cn "examples" draft/CanShift.can draft/CanVolunteer.can` + full reads of the fanout neighborhoods — no `examples` block attached to any `each=` scenario.
4. `rg -n "review_commitment|review_swap|refresh_reminders|cancel_signup|Superseded|supersed" draft/` — surfaced §C companion texts + confirmed no other re-trigger policy text.
5. `rg -n "each|fanout|cohort|for \(|for\(" draft/CanShift.mjs draft/CanVolunteer.mjs` + reads of the four `.mjs` handlers — per-child functions + routing metadata only.

### Handoff

- Writer: L4 T33-absence-confirm. WRITE ONLY
  `implementation/challenge-audit-run/evidence/fanout-decision.md`
  (appended this section + items 4–5 markers); all drafts, normative
  docs, tasks/monitor/inbox, code, and `tools/jev.py` untouched; no
  JEV run; no Git; no builds.
- Release: this file is RELEASED to the coordinator. Gate-needs #4+#5
  complete; remaining gate needs per checklist: items 1–3 (T24/T28/T32
  inputs), 6–8 (size record, Shift anchoring, syntax ordering), 9 (JEV),
  10 (T34 proof plan).

## T28-ownership input (gate evidence)

Writer: T33 gate-inputs (T28 slice). Status: **PREP — adopts NOTHING.**
APPEND-ONLY: all prior sections byte-identical; checklist items 1-3 text
untouched (verdicts recorded here, not in the checklist). Read-only
transcription + mapping; no builds, no JEV, no Git.

Checklist item fed: item 2 (fanout-decision.md:323-327) — T28 ownership
input for `swap.parent.parent` (Shift:245), the `event.opportunity.Signup`
reverse collection (Volunteer:178), and any imported-containment facets the
cohort language may traverse; "gate needs at least the ownership rule for
locally contained cohort parents."

Verdict: **COMPLETE.** T28 is ticked COMPLETE with Alternative A adopted
(tasks.md:247-252). The adopted rule is transcribed verbatim in §1 with
standing obligations in §2. All four fanout cohort parents are
package-local (§3 census), so the governing rule for the four sites is the
pre-existing local-containment semantics (DESIGN, read-only), confirmed as
T28-A's reference; T28-A adds the plain-import extension plus bound
rejection, which no current fanout site exercises.

### §1 — Adopted T28-A rule, verbatim

tasks.md:252 (T28 evidence, verbatim excerpt): "T28 COMPLETE with
Alternative A adopted; standing obligations: T29/T16/T17 atomicity proof +
split diagnostic; DECISIONS recording left for Codex review." JEV record:
unanimous ADOPT A 3/3 — R1 .49 / R2 .52 / R3 .74; B runner-up .42/.41/.08;
C at most .05; stable winner, unstable margins (tasks.md:252;
evidence/jev-t28-20261005/README.md:45-49; model jev-1.13.0, 3505/195
tokens, all exit 0 — README.md:42-43).

containment-decision.md:65-72 (Alternative A rule, verbatim):

> Rule: `Child in ImportedParent` has exactly the local-containment semantics
> (team/storage inheritance, immutable `parent` binding, atomic subtree
> archive/delete, parent-scoped uniqueness, `parentRecord.Child` typed
> collection) whenever the parent arrives via a plain import whose owning
> package is included in the selected app. Bound (`from=`) parents are rejected
> as containment targets with a diagnostic.

Supporting facets (containment-decision.md:74-84): declaring identity stays
with the child package (only the parent type is imported); plain import =
same deployment with owner transaction rules, bound import = remote with
containment forbidden (reference field instead); storage owner = the
parent's owner (already the same included store); child CRUD owned by the
declaring package; parent package policy governs parent rows; consumer
cannot mutate parent or extend its policy; reverse relationships resolve as
typed `parentRecord.Child` collections through the whole-app index, readable
only where child read policies grant.

Gate outcome (containment-decision.md:1108-1115, verbatim): "**Gate outcome:
ADOPT Alternative A (plain_import_containment).** Declaring identity stays
with the child package; plain import = same deployment with owner
transaction rules; bound (`from=`) parents stay rejected as containment
targets. Standing obligations (not waived): T29/T16/T17 must prove
same-store atomic cross-package subtree commits; a deployment-split
diagnostic is owed; B's coupling objection is the retained opposing case for
T29 review. Normative recording (DECISIONS entry) left for Codex review; no
normative doc edited here."

JEV README gate outcome (evidence/jev-t28-20261005/README.md:69-76,
verbatim in substance): ADOPT Alternative A (plain_import_containment),
unanimous across three independently worded equivalent requests, C rejected
everywhere, D at noise level in two of three; standing obligations carried
forward, not waived (same-store atomic proof + split diagnostic); T29 needs
matching T15/T16/T17 facts still pending; normative recording left for Codex
review.

Local-containment reference semantics (DESIGN, read-only via
containment-decision.md:30-36, verbatim): "`Model in Parent` creates an
implicit required immutable `parent:Parent`; the child inherits the parent's
team and storage owner; `parentRecord.Child` is a typed collection; changing
containment is not an ordinary update; delete archives the subtree
atomically; a child write does not advance the parent version; uniqueness
scopes within the containing parent; `parent` is a protected contextual
binding; creation defaults may read `parent`."

### §2 — Standing obligations and qualified boundaries (owed, not waived)

- Storage item 5 QUALIFIED (containment-decision.md:829-858; tasks.md:252):
  spec YES (one owner, one store, one atomic commit — DESIGN.md:532/362/338
  via containment-decision.md:862-869; contract restates the unit and the
  no-cross-store-transaction boundary — contracts/state.ts:276-279/359-362
  via containment-decision.md:870-876), engine UNPROVEN (no cascade code —
  `cascad` grep over state engine + contracts zero hits; delete archives one
  row — crud.ts:153-155, pipeline.ts:691-705; generated path still B1 interim
  — stdlib.ts:1-14, invoke.ts:1-11; all via containment-decision.md:949-974),
  split diagnostic ABSENT (no check keys on deployment topology; E2008/E4040/
  E4051 do not cover it — containment-decision.md:1007-1015). Engine proof
  owned by T29/T16/T17.
- T29 NOT started (tasks.md:254-259, Evidence: pending). E2008 still rejects
  imported parents at 20/20 sites (read-decision.md:1466-1467). T29 needs
  matching T15/T16/T17 (tasks.md:257); current status T15 OPEN (tasks.md:156),
  T16 COMPLETE (tasks.md:163-168), T17 partial with T17b remainder
  (tasks.md:170-175: stdlib routing, commit-guard lift, INTERIM_DDL
  retirement still owed).
- Normative recording: DECISIONS entry left for Codex review; no normative
  doc edited by the gate (containment-decision.md:1114-1115).
- Retained opposing case: B's coupling objection — consumer-triggered
  cascades touching owner-adjacent rows; atomicity promise rests on owed
  engine work plus a split scenario with no diagnostic
  (evidence/jev-t28-20261005/README.md:62-65; containment-decision.md:95-102
  full case).

### §3 — Fanout-site ownership census (all four sites local)

- Shift: `package shift` (CanShift.can:8); `Roster` (:40);
  `Availability in Roster` (:41); `Commitment in Roster` (:42);
  `Duty in Commitment` (:45); `Swap in Duty` (:47). Site 1 `each=Commitment`
  (:237); site 2 `each=Swap` (:243); `let commitment=swap.parent.parent`
  (:245) traverses Swap to Duty to Commitment — all package-local links.
- Volunteer: `package volunteer` (CanVolunteer.can:5); `Community` (:18);
  `Opportunity in Community` (:19); `Signup in Opportunity` (:20);
  `Task in Signup` (:21). Site 3 `each=Signup` (:47, filter
  `signup.parent.id==event.id` at :49); site 4
  `each=event.opportunity.Signup` (:178) traverses the local
  `Opportunity.Signup` typed collection.
- Disjointness from T28's 20 E2008 sites: the 20-site table
  (containment-decision.md:283-304) names children Expense,
  CommercialHistory, CommercialSale, Invoice, Calendar, Allowance, Service,
  Membership, BenefitRequest, BenefitFence, AccessWatch, Checklist, Proposal,
  Visit, GuestPolicy, HostPresence, Capture, Account, Entry, PeriodReview —
  none is Commitment, Swap, Signup, Opportunity, Roster, Duty, or Community.
  Zero overlap (table census).
- Bound parents: zero corpus-wide (containment-decision.md:312-328: all 76
  `from=` lines bind capability interfaces or value types only; Employee,
  Customer, Location never bound). Shift/Volunteer `from=` lines bind only
  ScheduleRequests/Mail (CanShift.can:11,13; CanVolunteer.can:9), never cohort
  parents. T28-A's bound-rejection clause is inapplicable to all four sites,
  and untested by draft evidence in both directions per its own record
  (containment-decision.md:330-336).
- Imported-containment facets traversed by current cohort language: NONE.
  Conditional only: if the adopted cohort language later traverses an
  imported parent, T28-A governs (plain allowed with full local semantics;
  bound rejected with diagnostic).
- Parent-selector legibility: R07 parent selectors accepted via T08
  (containment-decision.md:42-43; tasks.md T08 ticked COMPLETE) — path SHAPE
  only, distinct from containment-target acceptance
  (read-decision.md:1471-1473). No conflation claimed here.

### §4 — Mapping to fanout alternatives A-D (kills nothing)

- Alternative A — durable checkpointed fanout, both cohort spellings
  (fanout-decision.md:94-150). SUPPORTS the reverse-collection half's
  legibility: `event.opportunity.Signup` traverses a `parentRecord.Child`
  typed collection confirmed for local containment
  (containment-decision.md:30-36) and extended to plain imports by T28-A
  (containment-decision.md:67-72); confirmatory for site 4 (local), not new.
  CONSTRAINS A's proof: checkpoint-advance-in-same-owner-batch
  (fanout-decision.md:110-112) relies on same-store atomic batch — spec YES,
  engine proof owed via T16/T17 (T29's cross-package part unneeded for these
  same-package sites; T17b remainder per tasks.md:175 still owed). NEUTRAL on
  A's bare-model half: T28-A supplies no whole-model enumeration coverage
  (storage survey: corpus exercises only default-D1 team-scoped topology —
  containment-decision.md:919-926), so A's 499/500/501/1000 completeness proof
  stands exactly as stated. Bound clause inapplicable (§3).
- Alternative B — single-transaction bounded fanout
  (fanout-decision.md:152-201). NEUTRAL. B's single-owner-transaction premise
  is consistent with T28-A's same-deployment owner-transaction rule
  (containment-decision.md:76-78) but needs nothing from it — all four sites
  are same-package local, same-owner by construction. Cap, all-or-nothing
  atomicity, conflict retry, and whole-sweep semantics untouched by
  containment. Shared note, not B-specific: B's trigger batch touching parent
  plus children in one commit relies on the same T16/T17 atomic-batch proof as
  A, minus any T29 cross-package part.
- Alternative C — no fanout primitive; remodeling
  (fanout-decision.md:203-250). SUPPORTS remodeling vocabulary: explicit
  queries over `parentRecord.Child` plus `parent` navigation remain legal
  under confirmed local semantics; plain-imported traversal available if a
  remodel crosses packages (T28-A extension). Does NOT satisfy C's R19 flip
  burden — fanout-decision.md:244-249 demands a continuation design with EQUAL
  completeness/recovery; containment settles relations, not enumeration
  completeness. C's keep-E1203 stance untouched (different diagnostic,
  different gate; T28-A governs E2008 targets, not `each=`).
- Alternative D — parent-anchored cohorts only
  (fanout-decision.md:251-296). SUPPORTS anchored-cohort legibility most
  directly: D's cohort language (parent-anchored collections) traverses
  exactly the `parentRecord.Child` shape T28-A confirms (local for site 4 —
  CanVolunteer.can:19-20; plain-imported extension available). CONSTRAINS D's
  proof identically to A within adopted cohorts (same machinery —
  fanout-decision.md:263-266; T16/T17 batch proof owed, T29 cross-package part
  unneeded locally). CONSISTENT with D's bare-model remainder: T28-A makes no
  whole-model directory promise, so bare-model staying blocked until a
  coverage contract exists contradicts nothing in T28-A.

### §5 — Genuinely indeterminate (never forced)

- **JEV-PENDING** (T28 to A/D parent-archive-mid-flight): T28-A specifies
  atomic subtree archive at spec level, but the cascade is unimplemented and
  the generated path interim (containment-decision.md:949-974), while draft
  cascade/orphan intent is 20/20 absent (containment-decision.md:468-475). No
  evidence pins what a frozen A/D cohort does when the cohort parent is
  archived mid-flight (children skipped, failed, or cohort voided). The gate
  must rule without draft or engine grounding.
- **JEV-PENDING** (T28 to A/D checkpointed-child-of-archived-parent): compounds
  the existing skip-vs-fail marker (fanout-decision.md:117, which covers a
  concurrently DELETED child) — the archived-PARENT-of-live-child outcome
  (skip vs fail vs inherit-archive) has no draft anchor (same 20/20 absence)
  and no engine behavior. Distinct question, same absence.

## T24-dispatch input (gate evidence)

Writer: T33 gate-inputs (T24 slice). Status: **PREP — adopts NOTHING.**
APPEND-ONLY (same reservation as the T28 section above). Read-only
transcription + absence record; no builds, no JEV, no Git.

Checklist item fed: item 1 (fanout-decision.md:320-322) — "T24 dispatch
evidence: atomic trigger-commit/outbox-staging shape and recovery-scan
behavior that A/D fanout intents would ride on (T24 pending — applicable
slices must land before the gate can accept A/D)."

Verdict: **ABSENT — exact absence record; nothing to qualify.** T24 has no
writer, no slice, no commit, no evidence file. Task text transcribed verbatim
in §1 (tasks.md:219-224). Prerequisites: T16 COMPLETE (tasks.md:163-168),
T17 partial with T17b remainder (tasks.md:170-175), T13 COMPLETE
(tasks.md:142), T14 COMPLETE (tasks.md:149) — bound-send contract slices
satisfied; T24 itself not started.

### §1 — T24 task text, verbatim (tasks.md:219-224)

> - [ ] **T24 — Join generated effects to durable dispatch**
>   - Prerequisites: T16/T17 and matching effect contracts; bound sends
>     matching T13/T14.
>   - Owner / files / interfaces: L4 with L3/L7 join;
>     packages/work/src/dispatch/index.ts, packages/work/src/intent/index.ts,
>     packages/work/src/kernel/commands.ts, packages/work/src/recovery/index.ts;
>     packages/state/src/effects/staging.ts, packages/state/src/ports/
>     transact.ts (L3 writes); packages/cloudflare/src/runtime/invoke.ts,
>     packages/cloudflare/src/runtime/stdlib.ts, packages/cloudflare/src/runtime/
>     context.ts, packages/cloudflare/src/runtime/env-assembly.ts,
>     packages/cloudflare/src/runtime/mcp-registry.ts, packages/cloudflare/src/
>     worker/assembly.ts (L7 writes). Serialize overlapping producer-owned
>     writes.
>   - Changes / traceability: RQ03/RQ05; canonical design/task: Accountable
>     lead: L4 with L3/L7. Depends on T16/T17 and the relevant effect/operation
>     contracts; bound sends additionally require matching T13/T14 slices. Stage
>     domain/history/replay/outbox/dispatch atomically. Done when the full
>     promised rollback, guards, skipped outcomes, retry and recovery satisfy
>     their contracts.
>   - Acceptance: Atomic domain/history/replay/outbox staging connects actual
>     generated effects to dispatch; origins/guards/skips/rollback/retry/
>     recovery proved; never infer cross-store atomicity.
>   - Evidence: pending; record revision, commands/results, positive/negative/
>     runtime level and released handoff.

T33 brief dependency (tasks.md:282-287): T33 prerequisites cite "matching
T28/T24 evidence"; acceptance "requires applicable T28 ownership and T24
dispatch evidence plus the design consultation protocol"; coordinator status
"remaining: T24/T28/T32 inputs + JEV." T34 (tasks.md:289-294) requires
adopted T33 plus T24 plus applicable T28/T29/T32.

### §2 — Absence record: what exists (substrate, NOT T24 evidence)

- `@canlang/work 0.0.0` (14 kernel entries: intent/outbox/event/schedule/
  dispatch-guard/receipt/recovery) backs receipt observation and durable
  dispatch behind DeliveryResult; no draft imports it directly
  (interface-inventory.md:85). Existence only.
- `packages/state/src` carries effects staging/outbox/intent ports the T24
  join will use; no T12 claim beyond existence (interface-inventory.md:89).
- `CommitBatch` atomic batch shape including outbox
  (contracts/state.ts:281-298 via read-decision.md:1181-1183;
  `CommitBatch.outbox`/`outboxAck` via read-decision.md:1281-1282).
- Single-shot fenced commit port, no retry; fence conflicts surface as
  retryable `busy` (ports/transact.ts:1-48 via read-decision.md:1177-1180).
- T16 COMPLETE: canonical verified-context admission plus ports, no parallel
  engine (tasks.md:168). T17a done: canonical-validator redirect,
  invokeRead/createReadInvoker, durable 8/8 on miniflare D1 plus workerd DO
  with restarts explicitly unclaimed (tasks.md:175).

### §3 — Absence record: what is missing (exact)

- The T24 join itself: atomic domain/history/replay/outbox staging connecting
  ACTUAL GENERATED effects to dispatch (tasks.md:223) — no implementation,
  no proof.
- Origins/guards/skips/rollback/retry/recovery proofs (tasks.md:223).
- T17b remainder upstream: stdlib create/set/deleteRecord routing to the
  canonical engine, records() to createReadInvoker/invokeRead, commit-guard
  lift, stdlib direct paths plus router interim path plus INTERIM_DDL
  retirement (tasks.md:175) — generated operations still partially interim.
- Fanout-specific substrate (A/D): fanout-intent staging atomically with the
  trigger commit plus durable checkpoint table plus recovery scan
  (fanout-decision.md:137-141) — design text only, no implementation.
- Recovery-scan behavior for duplicate-trigger replay and crash resume
  (needed by fanout-decision.md:320-322; provided nowhere).
- Census: `rg "T24"` over implementation/challenge-audit-run/evidence returns
  only checklist/plan mentions (fanout-decision.md:138,190,320-321,554;
  hook/read-decision substrate-plan mentions; interface-inventory B3/B10 scope
  tags) — zero T24 completion claims. No `evidence/*t24*` or
  `evidence/*dispatch*` decision file exists (evidence dir listing: app-intent,
  containment-decision, continuation-contract, execution-contract,
  fanout-decision, hook-decision, interface-inventory, jev-t28-20261005,
  read-decision, root-causes).

### §4 — Mapping to fanout alternatives A-D (absence bars acceptance, kills nothing)

- Alternative A (fanout-decision.md:94-150). BLOCKED on T24: needs BOTH basic
  staging (trigger transaction's domain/history/replay/outbox) AND
  fanout-specific substrate (intent staging atomically with trigger commit —
  fanout-decision.md:138-139; checkpoint table; recovery scan —
  fanout-decision.md:137-141). Per checklist item 1's own text, applicable
  slices must land before the gate can accept A (fanout-decision.md:320-322).
  Absence kills nothing (no evidence against A's design); it bars ACCEPTANCE,
  not consideration. A's T34 proof burden (crash resume, duplicate-trigger
  replay, retry horizons — fanout-decision.md:139-141) presupposes T24
  recovery machinery.
- Alternative D (fanout-decision.md:251-296). Identical to A, scoped to
  anchored cohorts (same machinery — fanout-decision.md:284-288). Same
  verdict: acceptance blocked until applicable T24 slices land; design
  unrefuted.
- Alternative B (fanout-decision.md:152-201). Needs T24-BASIC only: "T24 join
  is the ordinary already-planned outbox staging" (fanout-decision.md:190-191);
  no new intent type, checkpoint table, or recovery scan
  (fanout-decision.md:189-192). Still unexecutable without T24-basic:
  Volunteer children send Mail, schedule, and cancel (CanVolunteer.can:52,
  150,170,184,191), which require atomic outbox staging. As a DECISION, B's
  rule (single-transaction bounded iteration — fanout-decision.md:154-157)
  carries a lighter T24 bar than A/D — but whether the gate may accept B's
  rule before T24-basic lands (T34 proving after) vs must wait is unpinned
  (checklist item 1 names A/D only). See §5.
- Alternative C (fanout-decision.md:203-250). As a LANGUAGE decision (keep
  `each=` rejected — fanout-decision.md:205-209), needs NO T24 evidence: the
  gate could scope fanout without dispatch. C's REMODELED WORKFLOWS still need
  T24-basic to execute (same sends/schedules as B), and C's site-by-site
  equivalence witnesses (fanout-decision.md:227-232) need T23 example
  execution (T23 OPEN — tasks.md:212) plus T24 dispatch. Decision unblocked;
  execution plus proof blocked. Both halves recorded; neither is a kill.

### §5 — Genuinely indeterminate (never forced)

- **JEV-PENDING** (T24 to B acceptance ordering): checklist item 1 orders A/D
  acceptance after applicable T24 slices (fanout-decision.md:320-322) but is
  silent on B. May the gate accept B's single-transaction rule with T24-basic
  as a T34 prerequisite, or must T24-basic land first? No evidence pins the
  ordering. (For A/D the ordering is SETTLED by the checklist — no marker. For
  C-as-scoping no dispatch evidence is applicable — no marker.)

## T32a-read-rule input (gate evidence)

Writer: T33 gate-inputs (T32a slice). Status: **PREP — adopts NOTHING.**
APPEND-ONLY (same reservation). Read-only transcription of settled fence
fragments plus qualified boundaries; no builds, no JEV, no Git.

Checklist item fed: item 3 (fanout-decision.md:328-331) — "T32 read-fence
input: child bodies re-read current state (version guards, `eligible()`,
`can_work()`); per-child staleness/revocation boundaries come from the
accepted T32a rule (T32a prep done, gate pending)."

Scoping note (exact): the tasks.md T33 brief (tasks.md:283-285) names T28/T24
evidence, NOT T32. T32 input is required by prep checklist item 3 plus
coordinator status "remaining: T24/T28/T32 inputs + JEV" (tasks.md:287), not
by the task brief. Recorded exactly as scoped; whether T32a absence blocks
acceptance is carried as pending (§4), never inferred.

Verdict: **QUALIFIED — settled fence fragments (F1-F8) transcribed below with
boundaries; NO ADOPTED READ RULE.** T32a JEV not run (read-decision.md:397-400
checklist item 8; no `evidence/jev-t32*` directory — dir-listing census; `rg`
for a T32a JEV-outcome section returns zero hits). Checklist: items 1,2
COMPLETE; item 3 COMPLETE; item 5 COMPLETE; item 7 COMPLETE; item 6 QUALIFIED;
item 4 (R29/T23) OPEN; item 8 (JEV) OPEN (read-decision.md:356-400;
tasks.md:275-280). All four T32a alternatives still carry pending markers;
none ranked or adopted (read-decision.md:354: "No alternative is ranked or
adopted here. Ranking is the JEV gate's job.").

### §1 — Settled fragments, verbatim with refs

F1. DESIGN revocation boundary (read-only settled context —
read-decision.md:44-50, verbatim): "a completed membership removal prevents
new admissions; an already admitted operation may finish; on D1 the fenced
commit also detects intervening membership changes (L291). Role predicates use
current admission authorization state and the same commit fence as
caller-role checks, and must not become stored historical invariants that
invalidate old records on later revocation (L295)."

F2. DESIGN fence (read-decision.md:51-62, verbatim): "admission-time
authentication, role, and active-membership facts are a **trusted context
snapshot** with the revocation boundary in §4; business eligibility requiring
atomic revocation must live at the same owner as the decision (L549). V1 D1
uses a database-wide optimistic revision fence: read the primary revision
before all state-dependent reads, evaluate bounded pure DSL, assert the same
revision in one batch, retry at most three times; submitted stale record
versions still produce `conflict` (L551-558). Pure read operations validate
the revision again after dependent reads; changed revisions retry rather than
return a mixed authorization snapshot. A successful mutation rechecks current
read permission before serializing its result (L558)."

F3. DESIGN settled no-preflight rules (read-decision.md:63-72, verbatim): "no
separate preflight authorization query is required for payment, since its
answer cannot authorize a later payment (L650); an unavailable/stale source
cannot expose an executable old action (L632); a send's optional `when` is a
pure dispatch guard over current owner state, checked atomically with
supersession before claiming the provider work (L524); mutable receipt
status/result/error reads enroll the observation revision in the read fence
(L668, L1077); completed replay returns the saved outcome projected against
current access, even though its submitted versions are now stale (L562)."

F4. DECISIONS settled plus open (read-decision.md:73-82, verbatim in
substance): #95 reject stale conflicting edits rather than silently
overwrite; #124 re-check guards at the authoritative storage location; #126
one authoritative coordinator per reservation resource; #129 persist
recoverable work only after authoritative acceptance; #143 transaction-time
snapshots for monetary values whose configuration can later change; #138 OPEN
— consistency guarantees for D1 mutations, replicas, and read sessions remain
unspecified; page-discovery admission reuses guard-needed bindings at the same
checkpoint (L739); payment dispatch validation adopted over a preflight read
(L703).

F5. Revocation-timeliness adjudication, item 3 COMPLETE
(read-decision.md:858-861, verbatim verdict): "**NOT silent — immediate
live-membership revocation; static role grants explicitly excluded as a
revocation channel.** Partially silent on exactly one point: no in-flight
(admit-then-revoke-before-commit) timing evidence exists." Evidence:
Grant:183 `deactivate` succeeds, then Grant:184
`colleague.active,reviewer(reviewer_user),can_work(reviewer_user,test_site)
-> false,true,false` (static grant SURVIVES, live flips), then Grant:185
`decide` by the deactivated reviewer errors; zero intervening operations
(read-decision.md:898-906). Fence-scope constraint on ALL T32a alternatives
(read-decision.md:944-952, verbatim in substance): the revocation fence must
enroll LIVE membership state (`Employee.active` / `can_work` /
`active_member`), never static role atoms alone — Grant:184 proves a
role-grant-keyed fence would wrongly allow Grant:185. Partial silence
(read-decision.md:927-933): no in-flight timing; asserted stale-version
conflicts (Grant:192,231,291,310) are version fencing, not revocation; DESIGN
L291 "already admitted may finish" UNANSWERED by Grant — genuine gate question
under every alternative.

F6. T06 admission-fact input, item 5 COMPLETE (read-decision.md:1003-1006,
verbatim verdict): "**COMPLETE — R26-layer-1 actor rule CONFIRMED as landed
(T06 ticked COMPLETE in tasks.md).**" Substance: admitted expressions carry
non-null actor facts via exactly four `DeclKey::CtxActor` insert sites
(scenario `by=` to guards+body; policy `read=` to `where=`; CRUD `by=` to
`when=`; boolean continuations via `collect_narrow`) — read-decision.md:
1049-1069; a TYPING fact only — grants no permission and no currency (T03 §9;
R04 boundary: check-time facts never become staleness promises) —
read-decision.md:1084-1087. Remaining E3010 purity rejections at pure-position
sites are NOT missing narrowing — actor-nullability settled (219 removed / 0
added, all actor-shaped); still-rejected admitted-actor sites are layer-2
purity (need the adopted fence) or genuine negatives —
read-decision.md:1087-1096. Pin: `t06_bounded_read_stays_gated` — a
state-reading call in a pure position STILL yields E3010 until T32 adopts
(read-decision.md:1096-1099).

F7. Durable-fence evidence plan, item 7 COMPLETE — PLAN, not proof
(read-decision.md:1168-1173, verbatim status): "**PREP — adopts NOTHING.**
Checklist item 7 evidence only; a PLAN, not proof." Substance:
per-alternative proof maps all require D1/DO execution (revision assertion,
interleaving, crash recovery, cross-owner fencing, revocation timeliness) —
read-decision.md:1222-1302; memory-store tests MAY claim deterministic unit
semantics only and MAY NOT claim durability, atomicity-under-crash,
fencing-under-concurrency, interleaving, cross-owner-fencing, or
revocation-timeliness — read-decision.md:1304-1319; DECISIONS #138 stays OPEN
until D1/DO-backed execution evidence for the adopted alternative exists —
read-decision.md:1321-1328; spend/dispatch paths proven on the T24 substrate
once it exists — "Until T24 lands, spend-fence claims are UNPROVEN — not
memory-proven" (read-decision.md:1275-1285). STALENESS NOTE: the plan's
runtime-status sentence ("T16, T17, T24 all OPEN with Evidence: pending" —
read-decision.md:1214-1220) predates T16 COMPLETE plus T17a; current status is
tasks.md:168 (T16 COMPLETE) plus tasks.md:175 (T17a done / T17b remainder).
Substrate mapping stands; status sentence superseded.

F8. T28-ownership input, item 6 QUALIFIED (read-decision.md:1356-1360,
verbatim verdict): "**QUALIFIED — T28 half CONFIRMED (adopted rule + JEV +
enumeration), T29 half ABSENT-with-reason (implementation not started; needs
matching T15/T16/T17).**" Substance: imported-parent reads enroll in the SAME
owner checkpoint / revision fence as a local read — no cross-owner fence
(read-decision.md:1384-1400); DESIGN same-owner rule satisfied by construction
(read-decision.md:1401-1408); grant decision stays with the owning policy;
revocation fence enrolls LIVE membership rows (read-decision.md:1409-1421);
bound rejected, no bound-parent read exists to fence
(read-decision.md:1422-1436); retained split-hazard caveat — same-fence holds
ONLY while the deployment stays shared, no split-time diagnostic
(read-decision.md:1437-1454). Net: enrollment RULED but UNPROVEN — no checker
acceptance (E2008 still rejects 20/20), no descriptors, no D1/DO fence
execution across the import boundary (read-decision.md:1495-1502).

OPEN (not transcribed — nothing settled): item 4 R29/T23 input-vs-observation
(read-decision.md:376-378, no writer, no marker); item 8 coordinator-run JEV
(read-decision.md:397-400). Enumeration items 1-2 (473 pure-position lines;
288-record spend inventory of 236 sends / 69 targets / 22 money-creates / 27
allowance-sets — read-decision.md:410-815; tasks.md:280) are COMPLETE
inventories cited here only as scope (236/69 corroborated against independent
T12 counts — tasks.md:280); per-site rows not transcribed.

### §2 — Qualified boundaries (what the fragments do NOT supply)

- No composed read/snapshot/revalidation contract: permission/revision/
  revocation fence combination, stale-read kinds, read-to-effect gap rule, and
  transitive-effect fencing differ across the unadopted alternatives A-D
  (read-decision.md:115-331, pending markers preserved there). F1-F8 constrain
  every alternative identically except where the mapping notes otherwise.
- No snapshot-semantics ruling: database-wide revision assertion (F2/L551) vs
  narrowed/pinned assertion is the T32a A-vs-C question
  (read-decision.md:232-238, marked pending there) — fanout B's "snapshot
  isolation" premise inherits this exact gap (see §3).
- No in-flight revocation ruling: DESIGN L291 "already admitted may finish" vs
  mid-flight revocation voids commit — open under every T32a alternative
  (read-decision.md:136-139, marked pending there; F5 partial silence).
  Fanout A/D per-child admission plus B whole-occurrence commit inherit it.
- No T23/R29 observation rule (item 4 open): fanout T34 proof observations
  (per-child outcomes, checkpoint state) inherit this blocker under EVERY
  alternative's proof tests, not just C's.
- Spend-fence claims UNPROVEN until T24 lands (F7) — fanout children that
  send/schedule (Volunteer sites — CanVolunteer.can:52,150,170,184,191)
  inherit the T24 absence recorded in the T24 input above.

### §3 — Mapping to fanout alternatives A-D (constrains all, kills none)

- Alternative A — per-child occurrences, frozen cutoff, version-guarded
  admission (fanout-decision.md:94-150). Fragments CONSTRAIN each per-child
  admission: `can_work` / `active_member` reads in child bodies (Shift
  review_swap invalidation predicate — CanShift.can:247; `eligible()` derives
  — CanShift.can:75-76; Volunteer `signup.version` / `parent.version` guards
  — CanVolunteer.can:150,184,191) must enroll LIVE membership state per F5,
  never static atoms; T06 typing (F6) reaches the guards but grants no
  freshness — admission must still fence. F7 REQUIRES D1/DO proof for A's
  checkpoint-advance-in-same-owner-batch, concurrent insert/move/remove
  interleavings, crash resume, and duplicate-trigger replay; memory may show
  shapes only. F8 settles same-fence enrollment for imported-parent reads in
  child bodies (rule) with proof owed (T29/T16/T17). NOTHING kills A; NOTHING
  completes A. A's skip-vs-fail (fanout-decision.md:117) and
  supersession-spelling (fanout-decision.md:130) questions are untouched by
  F1-F8 (F5 covers membership revocation, not record deletion or re-trigger) —
  still pending as stated. Acceptance ordering (fragments now + composed rule
  as T34 prerequisite, vs adopted T32a first) unpinned — see §4.
- Alternative B — whole-occurrence transaction, snapshot isolation, conflict
  retry (fanout-decision.md:152-201). Fragments CONSTRAIN the whole-commit
  fence identically (live-membership enrollment per F5; typing-is-not-freshness
  per F6; D1/DO proof per F7). SUPPORTS one B premise: B's "concurrent write
  fails the whole fanout for retry" (fanout-decision.md:167-169) aligns with
  settled DECISIONS #95 (reject stale conflicting edits — F4). WEAKENS BY
  ABSENCE another: B's "no insert/move/remove policy beyond snapshot
  isolation" (fanout-decision.md:167-169) presupposes a snapshot semantics T32a
  has NOT adopted (database-wide vs pinned — §2 above); B's snapshot premise
  is UNGROUNDED until T32a JEV — see §4. A grounding gap is not evidence
  against the design: kills nothing.
- Alternative C — remodeling under "ordinary read-fence rules (T32-gated)"
  (fanout-decision.md:211-213). MOST EXPOSED by C's own text: without an
  adopted T32a, C's "ordinary read-fence rules" do not exist. Remodeling
  queries inherit F1-F8 as fragments (live-membership enrollment, no-preflight
  F3, version-conflict F2/F4), but the composed rule is missing. C's
  site-by-site equivalence witnesses (fanout-decision.md:227-232) additionally
  need item-4 R29/T23 (open) plus T24-basic (absent). Prerequisite stack, not a
  kill: recorded as cost consistent with C's own costs section ("maximum
  per-site migration and review cost" — fanout-decision.md:238-240). As a
  LANGUAGE decision (keep `each=` rejected — fanout-decision.md:205-209), C
  needs no T32a evidence — same decision-vs-execution split as the T24 input;
  C's EXECUTION plus PROOF need the deepest stack (adopted T32a rule + T23 +
  T24).
- Alternative D — as A within adopted cohorts (fanout-decision.md:263-266).
  Inherits A's mapping EXACTLY within each adopted cohort (per-child receipts,
  frozen cutoff, version-guarded admission, per-child retry — same F5/F6/F7/F8
  constraints and proofs). Anchored-collection reads enroll the same-owner
  fence per F8 (settled rule, owed proof). D's bare-model remainder interacts
  with T32a not at all (blocked cohorts need no fence) — no constraint, no
  support. Same acceptance-ordering question as A (see §4).

### §4 — Genuinely indeterminate (never forced)

- **JEV-PENDING** (T32a to A/D acceptance ordering): checklist item 3 states
  per-child boundaries "come from the accepted T32a rule"
  (fanout-decision.md:328-331) without item-1-style blocking language, and the
  T33 task brief does not name T32 (tasks.md:283-285). May the gate accept A/D
  with F1-F8 fragments plus the composed fence rule as a T34 prerequisite, or
  must adopted T32a precede acceptance? No evidence pins the ordering.
- **JEV-PENDING** (T32a to B snapshot grounding): B's snapshot-isolation premise
  (fanout-decision.md:167-169) awaits T32a's database-wide-vs-pinned ruling
  (read-decision.md:232-238, marked pending there). May B be accepted with the
  snapshot kind as a T34 proof obligation, or does the gate need the adopted
  snapshot rule first? No evidence pins it. (C's T32-gating is self-declared in
  its own rule text — fanout-decision.md:211-213 — no marker; the gate reads
  C's text as written.)

## Gate-inputs handoff (T28/T24/T32a)

- Writer: T33 gate-inputs evidence writer. APPENDED three sections above plus
  this handoff to `implementation/challenge-audit-run/evidence/fanout-decision.md`
  ONLY; all prior sections byte-identical (no checklist-marker edits — items
  1-3 verdicts live in the appended sections); all drafts, normative docs,
  tasks/monitor/inbox, code, and `tools/jev.py` untouched; no JEV run; no Git;
  no builds (rg/reads only).
- Verdicts: T28-ownership COMPLETE (adopted A transcribed with obligations);
  T24-dispatch ABSENT (exact absence record — no writer, slice, commit, or
  file); T32a-read-rule QUALIFIED (F1-F8 fragments transcribed; items 4/8
  open; no adopted rule).
- Pending markers added: 5 (T28-to-A/D x2; T24-to-B x1; T32a-to-A/D x1;
  T32a-to-B x1). File total now 18 (13 prep + 5 here, verified by rg census).
  Zero adoption language: no fanout alternative recommended, ranked, or
  killed; T32a alternatives unranked.
- Gate fully fed? NO. Remaining: T24 applicable slices (blocking A/D
  acceptance per item 1); adopted T32a rule (item 3 qualified; ordering
  questions pending as marked); item 6 size record; item 7 Shift anchoring;
  item 8 syntax-ordering procedure; item 9 coordinator-run JEV; item 10 T34
  proof plan.
- Commands run (read-only): `rg -c/-n` censuses (pending markers, T24
  mentions, checkbox states, JEV-outcome absence); `ls` of evidence dirs;
  full reads of fanout-decision.md, containment-decision.md (Alternative A,
  storage, JEV outcome), jev-t28 README, read-decision.md appends (revocation,
  T06, fence-plan, ownership), tasks.md T13/T14/T15/T16/T17/T23/T24/T28/T29/
  T32/T33 lines, draft CanShift.can/CanVolunteer.can fanout neighborhoods.
- Release: this file is RELEASED to the coordinator for gate scheduling.

## T33 gate-input refresh + items 6-8, 10-skeleton (gate evidence)

Writer: L4 T33 gate-input writer (refresh slice). Status: **PREP —
adopts NOTHING.** APPEND-ONLY: all prior sections byte-identical except
the items 1+3 checklist markers above; items 2/4/5 markers, the four
alternatives, fairness record, and all prior appends untouched.
Read-only transcription + census + analysis; no builds, no tests run,
no JEV (`tools/jev.py` untouched), no Git, no tasks/monitor/inbox
edits. Every cited line/number was read in this slice.

Checklist items fed: item 1 REFRESH (was T24-ABSENT, now T24 COMPLETE)
in §R1; item 3 REFRESH (was QUALIFIED fragments, now T32a ADOPTED +
fence+wire LANDED) in §R3; item 6 (size record) in §R6; item 7 (Shift
anchoring analysis) in §R7; item 8 (syntax-ordering record) in §R8;
item 10 SKELETON (alternative-neutral T34 witness requirements) in
§R10. Items 2/4/5 complete elsewhere, untouched. Item 9 belongs to
the coordinator.

Verdicts: item 1 COMPLETE (landed shape transcribed; fanout-specific
substrate still T34-owed, recorded not waived); item 3 COMPLETE
(adopted rule + wired boundaries transcribed; standing obligations
recorded not waived); items 6/7/8 COMPLETE (records/analysis, zero
adoption); item 10 SKELETON ONLY (neutral witness list — any
alternative-specific proof plan needs adoption and is NOT written
here).

### §R1 — Item-1 REFRESH: T24 COMPLETE (landed shape A/D intents ride on)

tasks.md:224: "T24 TICKED COMPLETE: atomic staging + dispatch join +
origins/guards/skips/rollback/retry/recovery proven (memory + D1/DO)".
Commits (tasks.md:224): T24a staging join `468f20e`, T24b execution
wiring `45aa7c7`, root-gate fix `215023f` (unreachable-by-construction
guard, zero behavior change).

R1.1 Atomic trigger-commit/outbox-staging shape:

- `planDispatchStaging`
  (packages/work/src/intent/index.ts:295-347): every `GeneratedEffect`
  (211-222) lands in exactly one list — `staged` or `skipped`. Guards
  evaluate at stage time against the producer snapshot; only an
  explicit `true` stages (323-331). Fail-closed for the whole batch on
  duplicate derived ids, malformed requests/lineage, incoherent
  guards, or evaluator throws (286-294) — the caller stages nothing
  and the trigger batch rolls back.
- `work.dispatch.stage` command
  (packages/work/src/kernel/commands.ts:1142-1231): stages each
  intent's L4 `work.dispatch` row AND its L3 `OutboxIntent` in ONE
  fenced batch — one fence revision; a trigger rollback voids both
  (1117-1122). Guard-false intents stage a pinned-`false` dispatch row
  and NO L3 intent plus an explicit skip entry — skips are never
  silent (1131-1135). Exactly-once under retried runs: existing rows
  replay without writes on origin+verdict match, throw on mismatch
  (1137-1140). `operationId` must equal the run key; the true trigger
  origin rides `originOperationId` (1124-1129).
- L3 staging validation
  (packages/state/src/effects/staging.ts:84-147): intent
  `operationId` MUST equal the invoking operation (103-108), ids
  unique in batch (132-135), JSON-safe cloned arguments.
  `stageDispatchJoin` (263-283) derives origins + `when`-guard refs.
  SINGLE-OWNER SCOPE ONLY — cross-store atomicity is NOT claimed and
  must not be inferred (237-241).
- Join linkage assertion
  (packages/state/src/ports/transact.ts:198-249): exactly one
  `work.dispatch` insert per outbox intent (row id == `data.intentId`),
  non-false rows need their intent, guard-false row-only inserts are
  recorded skips; claim/recovery update batches pass trivially.
  `createDispatchJoinPort` (263-274) asserts then single-shot commits;
  fence conflicts surface as retryable `busy`.
- Commit gate: the marker is lane-3-minted and opaque here
  (intent/index.ts:85-93); `requireCommitted` throws when
  staged-but-uncommitted (385-392); `attemptDispatch` refuses
  uncommitted before anything else (dispatch/index.ts:122-126).

R1.2 Claim/record/requeue/reconcile/sweep semantics:

- Claim identity (dispatch/index.ts:167-195): exactly one winning
  claim id per intent per generation; `held-by-caller` replays
  idempotently, `held-elsewhere` refuses.
- `work.dispatch.claim` (commands.ts:189-270): ordering supersession
  -> settled -> guard pin -> claim (183-187); `expectedVersion`
  fencing so exactly one concurrent claimant wins; stale-claim
  reclaim path (235-255); refusals are result payloads, never errors
  (23-25).
- `work.dispatch.record-attempt` (287-372): attempts increment for
  provider attempts only, never skips (280-286); failed outcomes must
  carry `retryClass` transient/terminal (337-346); `ack` marks the L3
  intent dispatched when no further attempts follow.
- `work.dispatch.requeue` (391-498): transient-only retry; uncertain
  requires a `notFound: true` attestation (435-446); exhaustion is
  attempt cap OR horizon (447-450); dead-letter is a visible fenced
  outcome (451-464); deferrals hold until `availableAtMs` (465-475).
- `work.dispatch.release` (506-549): exact `isClaimStale` boundary;
  rows without a recorded claim stay claimed (a live dispatcher may
  hold them).
- `work.dispatch.supersede` (599-614): pending rows of one origin
  occurrence only; claimed/uncertain/settled rows never touched.
- `work.occurrence.put-receipt` (621-661): put-if-absent; losers
  replay the winner's receipt and never re-execute.
- `planRecoveryScan` (recovery/index.ts:453-529), decision table
  (437-451): claimed+stale -> `resume`; pending+guard-false ->
  `skipped`; failed-transient in-budget -> `retry`, exhausted ->
  `dead`, terminal/unclassified -> `terminal`; uncertain+not-found ->
  `retry`, decisive evidence -> `reconcile`, no evidence ->
  `awaiting`; delivered/dead need no action. All lists id-sorted.
- `work.dispatch.recover` (commands.ts:1246-1327): bounded batch
  release in stable intent-id order after the `resumeAfter` cursor;
  `done: false` means resume, never silently truncate; uncertain rows
  are OBSERVED read-only, never touched (1240-1242).

R1.3 Execution wiring + durable substrates (T24b):

- Composition seam `assembleDispatchCommands`
  (packages/cloudflare/src/worker/assembly.ts:1235-1243):
  `[...l3Commands, ...workCommands, ...stageCommands]`,
  order-enforcing, fail-loud on empty/duplicate names.
- Registry + join port
  (packages/cloudflare/src/runtime/invoke.ts:2546-2593):
  `createWorkerDispatchRegistry` over the composed array;
  `withDispatchJoinPort` routes every commit linkage-asserted.
- `stageDispatchBatch` (3153-3195): runs `work.dispatch.stage`,
  returns revision + staged/skipped/replayed.
- `driveDispatchIntent` (3263-3377): fenced claim -> claim-time
  guard re-evaluation on a CURRENT snapshot (3293-3319; evaluator
  throws propagate with the claim held) -> exactly one provider call
  -> one fenced record. Throwing/incoherent providers record
  `uncertain` (3329-3332). Delivered + terminal ack the L3 intent;
  transient + uncertain are left for the sweeper (3358).
- `runRecoverySweep` (3582+): recover batch -> per-state scans ->
  `planRecoveryScan` -> per-intent release/requeue/reconcile acts.
  Uncertain rows re-attest at act time; moved evidence skips with
  `evidence-changed` (3700-3708). Truncation flags on every scan —
  bounded sweeps never silently truncate
  (`RecoverySweepResult`, 3437-3469).
- Durable substrates: `t24b-dispatch-durable.test.ts` — Miniflare
  import (:28), real local D1 + real workerd DO SQLite handles
  (:128), `durableSuite("miniflare D1")` (:738) and
  `durableSuite("workerd DO")` (:744). Memory + D1/DO proven per
  tasks.md:224; restarts explicitly unclaimed.

R1.4 Fanout-carried, not fanout-decided: `FanoutLineage`
  (cohortId/parentOccurrence/childIndex/checkpointId,
  intent/index.ts:196-201) is documented "opaque carriers only ...
  applies NO fanout rule" (188-195); shape-validated and echoed in
  the planner (262-284) and the stage command (commands.ts:1067-1083).
  Two effects sharing a cohort stage/skip/dispatch as independent
  intents. T33 policy still undecided — carriers change no
  alternative's standing.

R1.5 Remainders (owed, not waived — tasks.md:224): bound sends (B8
  E3019, L4-owned); T34 fanout columns + adopted rule; cross-store
  atomicity never inferred; T08-parity expectation source. The
  fanout-specific substrate (fanout-intent staging atomically with
  the trigger commit + checkpoint table + recovery scan,
  fanout-decision.md:137-141) remains T34 design text — T24 supplies
  the SHAPE it rides on, not the fanout tables.

R1.6 Mapping delta vs the ABSENT record: A/D acceptance is no longer
  barred by missing basic staging/recovery — applicable T24 slices
  landed; what remains fanout-specific is T34's to build and prove.
  B's "ordinary already-planned outbox staging"
  (fanout-decision.md:190-191) exists, so the §5 T24-to-B ordering
  marker is MOOT as a wait question (nothing left to wait for on the
  T24 side) — recorded as resolved-by-landing, not as B adoption.
  C-as-language-decision still needs no T24 evidence; C's remodeled
  execution can now ride landed dispatch.

### §R3 — Item-3 REFRESH: T32a ADOPTED checkpoint_fence A + fence+wire LANDED

tasks.md:280: "T32a COMPLETE with Alternative A adopted"; "T32b-fence
mechanism done"; "T32b-wire done". Commits `1683200` (fence),
`47681e3` (wire). JEV, coordinator-run
(evidence/jev-t32a-20261005/README.md:65-77): UNANIMOUS ADOPT
checkpoint_fence A — R1 .65 (conf .53), R2 .80 (conf .73), R3 .76
(conf .67); runner-up framing-dependent (B .22 under safety; pinned
.15/.18); grants ≤.02; stable winner, soft confidence. Provider
flaked (529x1 + 503x3), all landed on retry, no content changed.

R3.1 Adopted rule, verbatim (read-decision.md:117-123): "every
state-dependent read in an operation (guard, `when=`, `derive`,
policy predicate, `active_member`/role check) executes at one owner
checkpoint enrolled in the existing revision fence. The commit batch
re-asserts the checkpoint revision AND re-evaluates permission +
revocation against current authority state; any intervening change to
a read dependency fails the operation with `conflict` (stale
revision) or `forbidden` (revoked permission), never a silent
commit." Facets: permission fence — admission + guards at the
checkpoint, commit rechecks `by` + every guard (125-128); revision
fence — settled D1 database-wide optimistic fence unchanged, all
reads enroll (129-131); revocation fence — membership/role facts are
the trusted snapshot, fenced commit detects intervening changes,
mid-flight revocation voids the commit (132-139); stale reads never
within the fence, eventual views labeled and never authorize/spend
(140-143); read→effect gap closed by construction (144-145); spend
rule — `when=` re-run atomically with supersession, `collect`
validates mandate at dispatch, no preflight crosses (146-149);
transitive effects are new fence scopes re-reading current authority,
never inheriting (150-152).

R3.2 Wired per-child staleness/revocation boundaries (T32b):

- Admission fence (packages/state/src/invocation/admission.ts):
  revision read BEFORE all state-dependent reads (291-294); scope
  opened at team ?? app (298); caller membership enrolled (329-330);
  record refs enrolled at observed version (367); imported-parent
  reads enrolled in the same scope (368-370); checkpoint snapshot
  carried on the call (382).
- Commit revalidation (`revalidateCommitForFence`, 584-629): order
  (1) eventual bar over offered readings (585-587), (2) revision
  assertion → `conflict` naming the enrolled-read count (588-595),
  (3) live authority revalidation → `forbidden` on revoked permission
  or flipped guard (599-628); trusted-kind skips step 3 only
  (596-598).
- Invoke wiring, success path
  (packages/state/src/invocation/invoke.ts:300-328): revalidation
  between execute and commit with checkpoint + `by` + executor guards
  + readings; `conflict` retries consuming an attempt; a voided
  commit throws with NOTHING committed and no receipt recorded.
- Invoke wiring, rejected path + REJECTED-RECEIPT RULE (230-262):
  rejected receipts respect the fence — a moved revision retries;
  but a rejection racing revocation STILL RECORDS (verdict decided on
  admitted authority, revocation voids writes, rejected receipts
  carry none: 233-236). The ORIGINAL error is rethrown, never the
  fence's `forbidden`; guards are unknowable on this path, so only
  revision + live `by`/revocation revalidate (238-240).
- By-aware projection + KNOWN EDGE (109-142): `public` → null/null,
  `authenticated` → team null, else faithful identity; compound gates
  admittable without caller membership can still false-void — no
  suite exercises compounds through invoke; the durable fix is a
  `by`-aware check inside the mechanism (125-127).
- Transitive scopes (packages/state/src/mutation/models.ts:126-151;
  pipeline.ts:621-636): hook bodies open FRESH scopes at the CURRENT
  revision with zero inherited deps; `triggerRevision` carried for
  diagnostics + dispatch claim sites; transitive `load` bypasses the
  provisional map — committed state only (623-626). The trigger point
  is revision+owner ONLY; dependencies never cross (pipeline.ts:68-77,
  243-248).
- Dispatch claim-time fence
  (packages/work/src/dispatch/index.ts:62-86, 122-156): transitive
  dispatches carry their OWN fresh checkpoint; presenting the
  trigger's revision back → `refused-inherited-scope` (131-137)
  before supersession/guard; after the guard passes,
  `revalidateAuthority` runs — revoked → `refused-revoked`, the claim
  never mints (154-156).
- Live-wins revocation
  (packages/identity/src/authentication/revocation.ts:52-66): the
  live row wins unconditionally; the checkpoint snapshot is never
  trusted; fail closed throughout.
- Eventual bar (admission.ts:525-532; query/engine.ts:891-930;
  ports/read.ts:67-71): eventual reads enroll nothing; the marked
  wrapper is refused at every authorization boundary; combining
  eventual with a fence throws (engine.ts:660-664, 924-927).
- L291 NARROWER reading pinned (admission.ts:573-578;
  revocation.ts:75-80): authority revoked between admission and
  commit VOIDS the in-flight commit. Still open: revocation racing an
  already-fenced commit batch (storage-atomicity question for the
  durable fence proof).
- Wire tests (existence):
  invocation/t32b-wire.test.ts, mutation/t32b-wire-transitive.test.ts,
  mutation/t32b-wire-durable.test.ts; state 683/683 per tasks.md:280.

R3.3 Standing obligations (owed, not waived — tasks.md:280):
cloudflare integration (runScenarioSeam/stageWrite guards+trigger,
driveDispatchIntent DispatchFence + REAL refused-* via
attemptDispatch); narrower per-team/per-record fence question;
active_member checker; by-aware mechanism check (compound false-void
edge); mutation/index barrel export. DECISIONS recording left for
Codex review.

R3.4 Mapping delta vs QUALIFIED fragments: per-child admission under
A/D now has an ADOPTED rule + wired state-side enforcement — F1-F8
are superseded by the composed contract for what they covered (fence
enrollment, commit revalidation, transitive freshness,
rejected-receipt fencing, L291 narrower scope). B's snapshot premise
is now GROUNDED as database-wide assertion (revision assertion
unconditional, admission.ts:588-595) with the narrower-fence question
carried as the named remainder — the §4 T32a-to-B marker NARROWS to
that remainder, recorded as narrowed-by-landing. C's "ordinary
read-fence rules (T32-gated)" now exist state-side; C's execution
still needs cloudflare integration + item-4 R29/T23 + T24-basic
(landed). The §4 T32a-to-A/D ordering marker is MOOT as a wait
question (adopted rule + wire exist). OPEN (gate sequencing, not a
JEV marker): whether the gate wants cloudflare T32b-integration
landed before accepting A/D, or accepts with it as a T34 prerequisite
— no evidence pins that sequencing.

### §R6 — Item 6: size record (no draft cohort approaches 499+)

Census (rg + reads of both draft files):

- Largest observed cohort-adjacent counts: Shift `assign` examples
  expect `count(roster.Commitment)` → 2 (CanShift.can:111-113);
  `count(Roster)` → 1 (CanShift.can:97-99); Volunteer `reactivate`
  expects `count(mentoring.Signup)` → 1 (CanVolunteer.can:107-109).
  Fixture populations: 14 fixtures in CanShift.can, 3 in
  CanVolunteer.can (`rg -c "fixture "`); the mentoring fixture sets
  `capacity=1` (CanVolunteer.can:39). No draft example, fixture, or
  companion text exhibits a cohort above 2 records.
- Bounds are caps, not observations: `limit=100` loops
  (CanShift.can:153,184,198,218,275), `limit=500` loops
  (CanVolunteer.can:143,163), `limit=1` (CanShift.can:319),
  `WorkBatch max=500` (CanVolunteer.can:13), the capacity invariant
  (CanVolunteer.can:36). A bound of N is not evidence of an N-sized
  cohort — recorded so the gate does not mistake caps for needs.
- 499/500/501/1000 are PROOF OBLIGATIONS, not observed needs: the
  audit plan states "Proof covers 499/500/501/1000 records,
  checkpoint crashes, duplicate source, concurrent insert/move/remove,
  rejected child, retry and supersession"
  (implementation/CHALLENGE-AUDIT-PLAN.md:398); CanShift.md:81 states
  the no-cap contract ("499, 500, 501 and 1,000 admitted identities
  all belong to the same complete contract, and the old rejecting
  500-row transaction bounds are gone"); CanVolunteer.md:77 defers
  "cohort sizes, crashes, fresh reads, interleavings and dispatcher
  fairness" to "shared-runtime fixtures".

Verdict: COMPLETE. The gate must not mistake proof sizes for
requirements evidence. This cuts no alternative: A/D must still prove
the sizes; B's cap fit is still unevidenced either way.

### §R7 — Item 7: Shift anchoring analysis for D (ANALYSIS, not ruling)

Question (checklist item 7): can the EligibilityReview sweeps be
faithfully remodeled per-roster/per-location/per-employee, or does
the null-or-match broadcast filter require whole-model coverage?
What follows is evidence + analysis. The gate decides; D's pending
markers (fanout-decision.md:271-275) stay pending.

Evidence:

- Event shape: `EligibilityReview { employee:Employee?,
  location:text?, account:user?, roster:Roster? }` (CanShift.can:49).
- Five emitters (CanShift.can:226-236): `employee_changed` →
  `{employee}`; `location_changed` → `{location=event.id}`;
  `member_removed` → `{account}`; `availability_changed` and
  `availability_created` → `{employee, roster}`. Roster is supplied
  by 2/5 emitters, employee by 3/5, location by 1/5, account by 1/5.
- Filter shape (`review_commitment` :239, `review_swap` :246): four
  null-or-match conjuncts — a null key matches every record.
- Anchor census: (a) roster IS the containment parent (`Commitment
  in Roster` :42; `Swap in Duty in Commitment` :45-47), and
  per-roster collections are used (`roster.Commitment` :74-79, :258;
  `event.roster.Commitment` :319) — BUT 3/5 emitters omit roster, so
  null matches all rosters. (b) employee is an IMPORTED type (`use
  employee {...}` :9), not a container — no `event.employee.…`
  collection exists; `Commitment.employee` is a reference field
  (:42). (c) the location key is a TEXT id (:49), matched as
  `commitment.location.id==event.location` — no record, no
  collection. (d) account is `user?` — no collection.
- Adjacent fact (noted, not adopted): `invariant Roster:
  count(Roster)==1` (CanShift.can:69) — a single roster satisfies the
  invariant today, but an invariant is not an anchor and does not
  supply the missing roster key.

Analysis verdict: on current draft shapes, NO single parent anchor
covers all five emitters — per-roster remodeling covers only
availability-sourced reviews (2/5); per-employee/per-location/
per-account anchors have no containment collection to traverse.
Whole-model coverage is what the null-or-match filter text describes
when keys are absent. Whether the gate accepts partial anchoring,
requires emitter remodeling to always supply roster, or keeps
whole-model coverage is the gate's decision (feeds D's markers +
JEV), NOT ruled here. No alternative adopted, ranked, or killed.

### §R8 — Item 8: syntax-ordering record (inventory WITHOUT ranking)

Ordering rule, verbatim (implementation/CHALLENGE-AUDIT-PLAN.md:396):
"Pursue a finite durable fanout contract and compare syntax only
after guarantees are concrete." Gate procedure: the T33 semantics
decision — adopt-or-scope with reasons for
cohort/checkpoint/identity/concurrent-change/failure/supersession +
costs (tasks.md:286) — precedes ANY spelling comparison; no syntax
vote precedes the semantics decision (checklist item 8,
fanout-decision.md:351-353).

Spelling inventory (observed shapes only — no voting, no ranking):

- S1. Bare-model scenario cohort: `each=Commitment`
  (CanShift.can:237), `each=Swap` (:243), `each=Signup`
  (CanVolunteer.can:47) — 3/4 sites.
- S2. Parent-anchored reverse-collection scenario cohort:
  `each=event.opportunity.Signup` (CanVolunteer.can:178) — 1/4 sites.
- Parser status: `each=<path> [as <name>]` parses (path + optional
  `as`-binding mirroring `send`/`create` aliases) but ALWAYS emits
  E1203 "unsupported scenario attribute `each`" non-fatally
  (compiler/src/syntax/parser.rs:4567-4614). No normative `each=`
  production exists: GRAMMAR.md/DESIGN.md/DECISIONS.md contain zero
  `each=` hits (`rg -c` census), and the parser comment notes the
  GRAMMAR trusted-scenario row lists only `on=` (parser.rs:4569-4570).
- Adjacent bounded-traversal vocabulary (candidate NEIGHBORS, not
  `each=` spellings — listed so the post-guarantees comparison set is
  complete; listing is not candidacy and not ranking): S3
  for-over-model `where`+`limit` (CanShift.can:218;
  CanVolunteer.can:161); S4 for-over-anchored-collection
  `where`+`limit` (CanVolunteer.can:143,163;
  CanShift.can:153,184,198,319); S5 for-over-let-bound-collection
  `limit=` (CanShift.can:275).

Verdict: COMPLETE as a record. The gate compares spellings only
after the completeness contract is concrete.

### §R10 — Item-10 SKELETON: alternative-neutral T34 witness requirements

Status: SKELETON ONLY — what ANY proof plan must witness,
independent of which alternative the gate adopts. Any
alternative-specific plan needs adoption and is NOT written here.
Sources: T34 acceptance (tasks.md:293), T34 scoping branch
(tasks.md:292,294), audit-plan proof sentence
(CHALLENGE-AUDIT-PLAN.md:398), T40 consequences (tasks.md:332,336),
T33 bar (fanout-decision.md:74-77, workflows 79-92).

Neutral witness list (each row: ANY adopted proof plan witnesses it;
a scoping disposition defers it with reasons, never ticks it):

1. Sizes: 499/500/501/1000 cohort completeness (tasks.md:293;
   plan :398).
2. Crash: checkpoint-crash resume without re-execution or
   misreported partial completion (plan :398 "checkpoint crashes";
   bar "partial execution is never reported as complete" :90).
3. Duplicates: duplicate trigger delivery replays the parent receipt
   and mints no new children (tasks.md:293; L520 precedent cited at
   fanout-decision.md:108-109).
4. Concurrent change: insert/move/remove during flight under the
   adopted membership rule (tasks.md:293; plan :398).
5. Rejected child: business rejection isolated per the adopted
   failure rule, reported, never silent (tasks.md:293; plan :398
   "rejected child").
6. Retry: transient retry horizons per the adopted rule
   (tasks.md:293 "retry").
7. Supersession: re-trigger-during-flight under the adopted rule
   (tasks.md:293; plan :398 "supersession").
8. T40 per-app consequences: Shift/Volunteer qualify only on adopted
   T34 (tasks.md:332); scoped mandatory workflows remain explicit
   gaps (tasks.md:336; fanout-decision.md:73,77).
9. Scoping branch: if C or D's remainder scopes, T34 records
   deferred reasons, never implementation completion
   (tasks.md:292,294).

No alternative-specific mapping is written: which witnesses bind
which alternative (cap enforcement under B, anchored-only proofs
under D, remodeling equivalence under C) is decided WITH adoption at
the gate.

### Refresh slice — commands run (read-only)

`rg -n "each="` census (4 sites, nothing else); `rg -c "fixture "`
(14 Shift + 3 Volunteer); `rg -on "-> [0-9]+"` + count-row reads
(largest observed 2); `rg -n "499|500|501|limit=|max=500"` over
drafts + companions; `rg -c "each="` over GRAMMAR/DESIGN/DECISIONS
(zero); `rg -n "E1203"` + read of parser.rs:4567-4614; full reads of
intent/dispatch/kernel-commands/recovery (work), staging/transact
(state), invoke.ts drive/sweep + assembly seam (cloudflare),
admission/invoke/models/pipeline (state), revocation (identity),
query/engine + ports/read fence hunks, dispatch fence hunks;
read-decision.md Alternative A (115-168); jev-t32a README;
tasks.md T24/T32/T33/T34/T40 lines; CanShift.can:1-49,205-265 +
CanVolunteer.can fanout neighborhoods; CHALLENGE-AUDIT-PLAN.md:392-398.

### Refresh slice — handoff

- Writer: L4 T33 gate-input writer. WROTE ONLY
  `implementation/challenge-audit-run/evidence/fanout-decision.md`
  (appended this section + items 1+3 markers); all drafts, normative
  docs, tasks/monitor/inbox, code, and `tools/jev.py` untouched; no
  JEV run; no Git; no builds; no tests run.
- Pending markers: ZERO added (`rg -c` stays 18; this handoff
  deliberately avoids the marker literal). Two earlier markers are
  recorded moot/narrowed-by-landing in §R1.6/§R3.4 with their text
  preserved. One OPEN gate-sequencing question is recorded in §R3.4
  without a marker.
- Zero adoption language: no fanout alternative recommended,
  ranked, or killed; no T34 alternative-specific plan written.
- Release: this file is RELEASED to the coordinator for gate
  scheduling. Gate-needs status after this slice: items 1/2/3/4/5/6/7/8
  fed; item 9 (coordinator-run JEV) + item 10 full plan (post-adoption)
  remain.
