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
2. T28 ownership input: `swap.parent.parent` navigation (Shift:245),
   `event.opportunity.Signup` reverse collection (Volunteer:178), and any
   imported-containment facets the cohort language may traverse (T28
   pending — gate needs at least the ownership rule for locally contained
   cohort parents).
3. T32 read-fence input: child bodies re-read current state (version
   guards, `eligible()`, `can_work()`); per-child staleness/revocation
   boundaries come from the accepted T32a rule (T32a prep done, gate
   pending).
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
