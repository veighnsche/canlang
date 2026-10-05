# T31a prep: permitted secondary hook writes — alternatives for the JEV gate

Status: **PROPOSED / PREP — adopts NOTHING.** Decision requires the
coordinator-run JEV protocol (three fresh, equivalent, independently worded
requests with saved advice/uncertainty) plus full-scope evidence. Every
alternative below carries explicit **JEV-PENDING** markers. No T31
implementation may begin before the gate accepts one rule, and T28 alone is
insufficient (T31 prerequisites: accepted T31a + T30 + canonical runtime).

Scope note (T31 brief): staged parent hooks, revision invalidation, atomic
rollback, version conflict, reentry/evaluation-order, forbidden
recursion/deletion. Done when staged revision invalidation, atomic rollback,
versions/history/replay and forbidden recursion/deletion are proved.

## Settled context (read-only inputs, not decisions)

- DESIGN hook contract (read-only here): pre-commit CRUD hook on
  `Model.create/.update/.delete`; `event.before`/`event.after`/`event.input`
  have generated types; at most one hook per model/CRUD operation. Hooks run
  on the proposed state before invariants/locks/commit, can reject or adjust
  it, and cannot introduce new client parameters. Before/input are read-only.
  `set event.after {fields}` adjusts the pending create/update record without
  recursively invoking CRUD; a delete hook can reject but cannot adjust its
  target. Hooks cannot call back into the triggering CRUD. Scenario effects
  emit committed model-change events and do not re-run CRUD hooks. A committed
  event handler is a later transaction; it cannot retroactively reject its
  source operation. Hook cycles are errors (DESIGN import section).
- DESIGN version rule: a created row has version 1 throughout its creating
  transaction, including create-hook adjustments. An accepted `set`, CRUD
  update or archive reserves `v+1`, even for a normalized same-value write.
  Update-hook `event.before.version` is `v`, `event.after.version` is the
  reserved `v+1`. A child write does not advance an unwritten parent. Failed
  operations advance nothing.
- R15 ([root-causes.md](root-causes.md)): spelling-based event/provenance
  rejection is bucket **b** (T30: renaming `event` changes no validity;
  verified declared references are not snapshots). Permitted secondary-hook
  writes are a SEPARATE medium-confidence semantic package (this T31a
  decision + T31), not implied by the spelling fix. Opposing (retained):
  hook snapshots must stay immutable; pending-source deletion and recursive
  triggering CRUD are dangerous; secondary writes need real owner fencing
  and revision invalidation.
- R27 ([root-causes.md](root-causes.md)): server-owned enforcement differs
  between the ordinary-update path (CanCheck:58 `set check {armed=now...}`
  rejected) and the hook path (CanCheck:99 `set event.after {armed=now...}`
  accepted). Bucket **b** (T18+T31); confidence medium. Flip: an adopted
  default/server/update/hook rule assigning `armed` writes to exactly one
  mechanism. Opposing (retained): `server=now` may mean runtime-stamped and
  never author-settable — then resume needs a supported re-anchor mechanism
  and the hook side is the hole to close.
- C6 ([root-causes.md](root-causes.md)): the E3001 `{opaque}` cluster at
  Check:99-100 is a consequence of incomplete `Check.create` after/before
  payload typing (R15/T30-T31 area), not independent type defects.
- R29 (Leave:136, bucket **c**, low confidence): input-vs-observation
  attribution for examples is unsettled pending the T23 emitted-example
  contract — hook-behavior examples inherit that blocker.
- R17 (Check:11, bucket **c**): supplied-opaque-secret ingress vs server
  initialization is a T36 residual; any hook rule touching secrets inherits
  its fencing requirement.
- App-intent dispositions (all ACCEPTED-WORKFLOW-INTENT, runtime negatives
  retained): CanCheck carries R27 + R15 secondary-write stakes; CanAffiliate
  L161/L191-195 `set event.partner` / `set event.settlement` are
  verified-declared-reference writes (T30 spelling fix, NOT hook writes);
  CanEvent L71-73 `set event {published=true}` is an ordinary-parameter
  write (T30 spelling fix, NOT a hook write). Only genuine `on=Model.create`
  / `on=Model.update` hook bodies are in T31a scope.
- Draft hook bodies using secondary writes today: CanCheck `initial`
  (L96-102: `set event.after` + `schedule`) and `configured` (L103-119:
  `set event.after` + `create Transition {parent=event.after...}` at L113 +
  `schedule`/`cancel` + `create Notice {parent=event.after...}` at L119).

## Workflows each alternative must preserve (acceptance bar)

1. CanCheck `initial`/`configured` hooks: pending-record adjustment
   (`armed`/`state`/`due`/`revision`) with before/after version fencing
   (`before.version=v`, `after.version=v+1`).
2. CanCheck `configured` secondary effects: `create Transition` and `create
   Notice` parented to the pending record, `schedule`/`cancel` of the
   Deadline timer — either staged atomically with the trigger or given an
   adopted replacement preserving the deadline/re-anchor workflow.
3. Revision invalidation: hook-observed state (e.g. `event.before.revision`)
   cannot silently authorize a commit over a concurrently changed row;
   version conflict surfaces instead.
4. Atomic rollback: if the triggering operation or any staged secondary
   fails (invariant/lock/version), no partial hook effect survives.
5. Negatives: recursive triggering CRUD, pending-source deletion, delete-hook
   adjustment, and snapshot (before/input) mutation all fail; a hook grants
   no authority beyond its owner's rules.

## Alternative A — Staged same-transaction secondary writes, no hook reentry

Rule: a create/update hook may `set event.after` (settled) AND stage
secondary writes (`create`/`set` on other owner rows, `schedule`/`cancel`)
that commit atomically with the triggering operation in one owner
transaction. Staged writes re-run invariants/locks, reserve their own
versions per the write-intent rule, and never re-invoke CRUD hooks
(flat staging, no cascading reentry).

- Staged parent hooks: children created with `parent=event.after` stage
  against the pending parent; parent-version reservation (`v+1`) happens
  once for the trigger, children get their own version 1 rows.
- Revision invalidation: every staged write enrolls its target's read
  revision in the existing fence; an intervening commit to any staged
  target invalidates and retries/fails the whole owner transaction under
  ordinary conflict rules.
- Atomic rollback: trigger + all staged secondaries commit or roll back
  together; a failing staged invariant voids the trigger too.
- Version conflict: concurrent change to the pending record or any staged
  target between hook read and commit yields `conflict`, never a silent
  overwrite.
- Reentry/evaluation-order: hook body evaluates once, in written order,
  against the proposed state; staged writes observe ordered provisional
  changes of the pending record but never trigger further hooks.
- Forbidden recursion/deletion: staged writes cannot target the triggering
  CRUD path (no `Check.create/update` from a Check hook), cannot delete the
  pending source, cannot adjust from a delete hook, cannot write
  before/input snapshots. **JEV-PENDING**: whether staged writes to the
  pending record's *other* models may name the same model via a different
  operation (e.g. `Check.delete` from a Check update hook) or whether all
  same-model CRUD is barred.
- Server-owned fields (R27): hook adjustment of `server=expr` fields follows
  the adopted T18 rule — **JEV-PENDING** whether hooks may write
  server-owned fields the ordinary-update path rejects, or whether R27
  closes the hook side and `resume` gets a re-anchor mechanism instead.
- Workflows preserved: bar items 1–5 hold verbatim, including CanCheck
  L113/L119 child creation and L100/L115 `schedule` with zero draft edits.
- Costs: the owner transaction grows to cover trigger + staged writes +
  staged invariant rechecks within the bounded-work budget; error messages
  must attribute a staged-write failure to the hook line that staged it;
  storage engine must prove single-owner atomicity for the staged set.
- Strongest opposing case: failure coupling — one over-broad staged write
  (or a contended staged target) now fails the user's triggering operation
  with a `conflict`/invariant error far from its cause; hook authors gain a
  footgun that turns every update into a multi-row transaction. **JEV-PENDING**:
  whether atomicity of trigger+children is draft intent or an
  implementation convenience, and what bounds staged-write fan-out.

## Alternative B — After-only hooks; secondaries via committed handlers

Rule: create/update hooks keep ONLY `set event.after` adjust/reject (the
settled core). Every secondary effect — child creation, schedule/cancel,
cross-row writes — must live in a committed-event handler
(`on=Model.created/.updated`), which runs as a later transaction and cannot
retroactively reject its source operation.

- Staged parent hooks: none — there is no staging. Committed handlers
  create Transition/Notice rows referencing the committed parent version.
- Revision invalidation: each transaction fences independently; the handler
  re-reads current authority state and applies ordinary guards.
- Atomic rollback: trigger rollback cannot strand staged writes (none
  exist), but trigger success + handler failure leaves a committed parent
  without its children — handler retry/recovery (T24 area) owns that gap.
- Version conflict: trigger and handler conflict independently; no
  multi-row conflict surface.
- Reentry/evaluation-order: hook evaluates once pre-commit; handlers run
  later, each exactly once per occurrence identity (duplicate deliveries
  replay receipts).
- Forbidden recursion/deletion: inherited from the settled core, plus a
  static ban on `create`/`set`/`delete`/`schedule` inside hook bodies —
  the smallest checkable surface.
- Server-owned fields (R27): hook-side adjustment shrinks to the settled
  `set event.after` set; if R27 closes the hook side, `resume` still needs
  its re-anchor mechanism — same **JEV-PENDING** as A.
- Workflows preserved: bar item 1 holds. Items 2/4 hold ONLY after
  remodeling: CanCheck L113/L119/L100/L115/L117 move to committed handlers,
  each needing demonstrated evidence per T36-style adjudication; the
  deadline workflow must be re-proven end to end (trigger commits, handler
  schedules). Item 5 holds trivially (narrowest surface).
- Costs: remodeling cost on every hook body with secondary writes; loss of
  trigger+children atomicity (partial success becomes possible); new
  reliance on handler retry/recovery for workflow completeness; two places
  to read one workflow.
- Strongest opposing case: it discards the drafts' plainly staged intent
  (CanCheck stages children and timers inside the hook body, guarded by the
  same `if` conditions as the pending adjustment) and pays atomicity + audit
  simplicity to preserve a narrow checker rule — the flip side must show
  concrete unsafety in staging, not just smaller transactions.
  **JEV-PENDING**: whether any staged workflow (deadline re-anchor with
  same-transaction Transition evidence) is inexpressible or unsafety-prone
  as committed handlers, and who owns the orphaned-parent gap when a
  handler fails.

## Alternative C — Declared narrow allowlist of staged secondary writes

Rule: hooks stage same-transaction secondaries as in A, but ONLY to targets
declared in the hook's contract: child rows parented to `event.after`
(`create Transition {parent=event.after...}`) and timer operations bound to
the pending record (`schedule`/`cancel event.after.id`). All other
secondary writes (cross-row `set`, unparented `create`, any `delete`) are
rejected in hook bodies and must use committed handlers as in B.

- Staged parent hooks: the allowlist's core case — parented children stage
  exactly as A.
- Revision invalidation / atomic rollback / version conflict: as A, but the
  staged set is statically bounded to declared targets, so the fence and
  rollback surface are auditable from the hook signature.
- Reentry/evaluation-order: as A (flat, no cascading hooks).
- Forbidden recursion/deletion: as A, plus the allowlist itself is the
  enforcement point — an undeclared staged write is a check-time error,
  not a runtime decision. Exact declaration syntax **JEV-PENDING**.
- Server-owned fields (R27): same **JEV-PENDING** as A/B.
- Workflows preserved: bar items 1–5 hold for CanCheck (all its secondaries
  are parented children or pending-bound timers — zero draft edits). Any
  future cross-row hook write pays B-style remodeling.
- Costs: new declaration surface (syntax, visibility, versioning of the
  allowlist); boundary disputes on every new hook ("is this write
  parented enough?"); two secondary-write mechanisms to teach, diagnose,
  and keep apart; if workflows later need cross-row staging, the allowlist
  grows toward A anyway.
- Strongest opposing case: arbitrary-line drawing — the parented/cross-row
  distinction is a syntactic proxy for blast radius, not a semantic safety
  boundary (a parented child can still carry dangerous payloads, and a
  cross-row `set` can still be harmless); authors will game the line by
  re-parenting writes to fit. **JEV-PENDING**: whether the allowlist
  boundary matches a real trust/atomicity boundary, and what happens to
  hooks whose needs fall just outside it.

## Alternative D — Staged writes with bounded cascading reentry

Rule: as A, except staged secondary writes to OTHER models re-run those
models' CRUD hooks, with static cycle rejection (hook cycles are already
DESIGN errors) plus a runtime depth bound. Same-model reentry into the
triggering CRUD path stays forbidden.

- Staged parent hooks: `create Transition {parent=event.after...}` runs
  Transition's create hook (if any) against the staged child; its
  adjustments join the same owner transaction.
- Revision invalidation / atomic rollback / version conflict: as A, extended
  over the cascade — any cascaded hook's rejection or conflict voids the
  whole transaction.
- Reentry/evaluation-order: cascade follows staging order depth-first; the
  depth bound (**JEV-PENDING** value) caps chains the static analysis
  misses (e.g. across dynamic dispatch); exceeding it fails the operation.
- Forbidden recursion/deletion: direct recursion into the triggering CRUD
  path stays forbidden; mutual-hook cycles are static errors; delete-hook
  and snapshot rules unchanged.
- Server-owned fields (R27): same **JEV-PENDING** as A/B/C.
- Workflows preserved: bar items 1–5 hold with zero draft edits (CanCheck
  has no Transition/Notice hooks today, so D behaves as A on current
  drafts); future composed hooks compose automatically.
- Costs: largest semantic surface — cascade order, depth bound, and
  cross-model hook interaction must all be specified, diagnosed, and kept
  within the bounded-work budget; failure attribution spans models; testing
  must cover cascade/conflict interleavings; storage atomicity proof covers
  the whole cascade.
- Strongest opposing case: spooky action at maximum — a one-line `create`
  in a hook can now trigger an unbounded (bound-capped, still surprising)
  chain of other packages' hooks inside the user's transaction, each able
  to reject the user's operation; debuggability and work-budget
  predictability suffer most here. **JEV-PENDING**: whether any draft
  workflow needs cascading hooks (none sampled does), and whether the
  cascade buys anything over explicit staging plus committed handlers.

## Fairness record (preserved opposing cases)

- A's risk: failure coupling — staged writes can fail the triggering
  operation far from the user's cause (this file).
- B's risk: atomicity loss + remodeling cost to preserve a narrow rule;
  orphaned-parent gap when a handler fails (this file; R15 flip burden).
- C's risk: arbitrary-line drawing with gaming pressure; two mechanisms to
  teach (this file).
- D's risk: spooky cascading action with worst debuggability and work-budget
  predictability; no sampled workflow needs it (this file).
- Cross-cutting R27 risk: if `server=now` means runtime-stamped, the hook
  side is a hole to close under every alternative, and `resume` needs a
  supported re-anchor mechanism.
- No alternative is ranked or adopted here. Ranking is the JEV gate's job.

## What the gate still needs (evidence checklist)

1. [COMPLETE — see "T30-completion input (gate evidence)" below]
   T30 completion: provenance-correct hook payload typing (C6 `{opaque}`
   cluster resolved) so the gate judges secondary-write rules, not payload
   opacity.
2. [COMPLETE — see "Hook-body enumeration (gate evidence)" below]
   Full enumeration of hook bodies with secondary writes across all 52
   sources (only CanCheck `initial`/`configured` sampled here) with
   per-site effect classification (parented child / timer / cross-row /
   delete attempt).
3. R27 input from T18: the adopted default/server/update/hook rule for
   server-owned fields — every alternative inherits its **JEV-PENDING**.
4. [QUALIFIED — see "T28-ownership input (gate evidence)" below]
   T28/T29 ownership input where staged writes touch imported references
   (T31 depends on applicable T28/T29; T28 alone is insufficient).
5. T23 example-contract input (R29): whether hook-behavior examples may
   observe through input bindings or must reload stored state.
6. [COMPLETE — see "Durable-transaction evidence plan (gate evidence)" below]
   Durable-transaction evidence plan: per T31 acceptance, memory evidence
   cannot prove durable transaction behavior. Memory stores lack the
   properties the gate must verify — no D1 batch/commit boundary, no
   Durable Object fencing, no crash-recovery path, no concurrent-transaction
   interleaving, no cross-authority partial failure. Atomic rollback,
   version-conflict, and revision-invalidation claims therefore require
   D1/DO-backed execution evidence (T16/T17 canonical runtime), not
   memory-store tests; the gate must say which alternative's proof runs
   where.
7. Coordinator-run JEV protocol: three fresh equivalent independently worded
   formulations, saved responses + uncertainty, disagreement investigated.
   **No JEV was run for this prep file; tools/jev.py untouched.**

## Handoff

- Writer: L3 T31a-prep. Single new file; DESIGN.md/GRAMMAR.md/DECISIONS.md
  untouched (read-only); state/compiler code untouched (T31 is post-gate);
  tasks.md/monitor.md/inbox untouched (coordinator-owned); no JEV run;
  no Git.
- Release: this file is RELEASED to the coordinator for gate scheduling.

## Hook-body enumeration (gate evidence)

Status: **PROPOSED / PREP — adopts NOTHING.** Checklist item 2 evidence
only; all alternatives stay unranked and every **JEV-PENDING** above is
preserved. Read-only `rg` inspection of the 52 `draft/**/*.can` sources;
`.mjs` desired-output files excluded; no builds, no JEV, no Git.

Method: a CRUD hook body is a `scenario <name> on=<Model>.create|update|delete`
block. Committed/fanout handlers (`on=X.created/.updated/.deleted`,
`each=`) are out of T31a scope (295 total `on=` scenarios corpus-wide;
44 are CRUD hooks). Each body below was read to its boundary (next
`scenario`/section start); `-A` window bleed into neighboring scenarios
was excluded by direct reads. Settled core = `set event.after {...}`
adjustment and/or `require` only; everything else is a secondary effect
classified per site as parented-child / timer / cross-row /
delete-attempt / other.

### Totals

- 44 CRUD hook bodies in 16 files (20 create, 23 update, 1 delete).
- 36 bodies carry secondary effects; 8 are settled-core-only (listed at
  the end); **0 delete attempts** anywhere (no `delete`/`archive`/
  `destroy` statement inside any hook body).
- Body-level effect classes (bodies multi-labeled): parented-child 17,
  timer 10, cross-row 8, delete-attempt 0, other 7 (bound `send` 2,
  `emit` 5).
- Site-level: 20 parented `create`s + 1 `set` on a staged child; 15
  static `schedule`/`cancel` ops + 1 timer fan-out loop; 8 cross-row
  `set`s; 2 bound `send`s; 5 `emit`s.

### Bodies with secondary effects (36)

Parented-child creates (`parent=event.after`, inside C-as-written):

- `draft/CanCheck.can:103` `configured` on=Check.update — L113 `create
  Transition {parent=event.after...}` parented-child; L119 `create Notice
  {parent=event.after...}` parented-child; L121 `set notice {...}`
  parented-child write. Also L115 `schedule`/L117 `cancel` timer
  (pending-bound); L120 `send Alerts.notify` other. Discriminates: B
  remodels everything (atomicity loss); C keeps creates+timers, silent
  on `send`; D identical to A here (no Transition/Notice hooks exist).
- `draft/CanMaintain.can:106` `retire_asset` on=Asset.update — L110
  `create Cancellation {parent=event.after...}` parented-child; L111
  `emit CancellationStep` other. Discriminates: C keeps the create,
  silent on `emit`; B remodels both.
- `draft/shared/Locations.can:33,37` `snapshot_Location_create/update`
  on=Location.create/update — L36/L40 `create LocationPolicy
  {parent=location...}` (location=`event.after`) parented-child.
- `draft/CanRent.can:338,342` `snapshot_Resource_create/update`
  on=Resource.create/update — L341/L345 `create ResourcePolicy
  {parent=resource...}` (resource=`event.after`) parented-child.
  Discriminates: snapshot `sequence=count(...)+1` makes B-remodel
  atomicity loss concrete (concurrent commits can duplicate sequence);
  C keeps these four; D identical to A (no Policy hooks exist).

Parented-child creates (`parent=event.after.parent`, OUTSIDE
C-as-written allowlist, which names only `parent=event.after`):

- `draft/CanMaintain.can:98` `revise_plan` on=Plan.update — L101 `create
  Cancellation {parent=event.after.parent...}` parented-child*;
  L102 `emit CancellationStep` other; L103 `cancel`/L105 `schedule`
  timer (pending-bound). Discriminates: C-as-written excludes the L101
  create (parented to the trigger's parent, not the trigger) — C needs
  extension or this body pays B-remodel; A covers all; B remodels all.
- `draft/shared/Locations.can:41,45,49,53,57,61` six child-snapshot
  hooks (WeeklyHours/ClosedDate/DateHours × create/update) — each `create
  LocationPolicy {parent=location...}` with location=`event.after.parent`
  parented-child*.
- `draft/CanRent.can:346,351,356,360` four child-snapshot hooks
  (Window/DayCalendar × create/update) — each `create ResourcePolicy
  {parent=resource...}` with resource=`event.after.parent`
  parented-child*; Window hooks additionally L350/L355 `create
  WindowEvidence {parent=event.after.parent...}` parented-child*.
  Discriminates: the `event.after`/`event.after.parent` line splits the
  snapshot family 4-inside/10-outside under C-as-written — the gate must
  say whether C's allowlist extends to trigger-parent parenting (then C
  keeps all 14 snapshots) or these 11 bodies remodel as B.

Pure pending-bound timer hooks (8 bodies, zero-edit under A/C/D):

- `draft/CanCheck.can:96` `initial` on=Check.create — L100 `schedule
  event.after.id` timer.
- `draft/CanContract.can:109` `arm` on=Obligation.create — L112
  `schedule` timer.
- `draft/CanContract.can:113` `rearm` on=Obligation.update — L115
  `cancel` + L118 `schedule` timer.
- `draft/CanSuccess.can:78` `arm` on=FollowUp.create — L81 `schedule`
  timer.
- `draft/CanSuccess.can:82` `reschedule` on=FollowUp.update — L84
  `cancel` + L86 `schedule` timer.
- `draft/CanSuccess.can:87` `account_created` on=Account.create — L92
  `schedule` timer.
- `draft/CanMaintain.can:92` `activate_plan` on=Plan.create — L96
  `schedule` timer.
- Plus `draft/CanSuccess.can:93` `account_changed` on=Account.update —
  L95 `cancel` + L99 `schedule` timer (pending-bound) AND L100-103
  `for` loop over `event.after.FollowUp` children with `cancel
  followup.id` + `schedule followup.id` timer (child-bound, fanned-out).
  Discriminates: the L100-103 loop is outside C-as-written (bound to
  children, not the pending record) and directly implicates A's
  **JEV-PENDING** staged-write fan-out bound; B remodels the whole body.

Cross-row `set` hooks (all OUTSIDE C-as-written; A stages, B remodels):

- `draft/CanOnboard.can:46` `template_step_created` on=TemplateStep.create
  — L47 `set event.after.parent {revision=...+1}` cross-row (parent row).
- `draft/CanOnboard.can:48` `template_step_changed` on=TemplateStep.update
  — L49 same cross-row shape.
- `draft/CanOnboard.can:50` `template_step_removed` on=TemplateStep.delete
  — L51 `set event.before.parent {revision=...+1}` cross-row from a
  DELETE hook. Discriminates: the only delete hook in the corpus; all
  alternatives pin only delete-hook *target* adjustment, so parent-row
  writes from delete hooks are unaddressed under A/B/C/D — gate gap.
- `draft/CanLeave.can:72,74,76,78` `day_created/day_changed/
  category_created/category_changed` — L73/L75/L77/L79 `set
  event.after.parent {revision=...+1}` cross-row (parent row).
  Discriminates: B-remodel moves the revision bump post-commit, changing
  revision-visibility semantics the gate must rule on (bar item 3 fence
  input).
- `draft/CanDiscover.can:247` `analyse_new` on=Evidence.create — L251
  `send Analysis.extract {...} as request` other; L253 `set evidence.run
  {analysis_slots=...+1}` cross-row (L252 `set evidence {...}` is
  settled-core: evidence=`event.after`). Discriminates: bound `send`
  inside a hook body is unaddressed by all four alternatives (shared gap
  with Check:120); the slot-counter bump has B-remodel race implications.

Emit-only hooks (other; unaddressed by all four alternatives — gate gap:
is `emit` staged with the trigger or post-commit?):

- `draft/shared/Employees.can:22` `changed` on=Employee.update — L25
  `emit EmployeeChanged` other.
- `draft/CanShift.can:233` `availability_changed` on=Availability.update
  — L234 `emit EligibilityReview` other.
- `draft/CanShift.can:235` `availability_created` on=Availability.create
  — L236 `emit EligibilityReview` other.

### Settled-core-only hooks (8, no secondary effects)

`draft/CanFeedback.can:76` `contribution_limit` (require only);
`draft/CanFeedback.can:79` `review_edited` (`set event.after`);
`draft/CanCreative.can:62` `template_edited` (`set event.after`);
`draft/CanCustomer.can:77` `contact_email_changed` (`set event.after`);
`draft/CanMember.can:229` `calendar_snapshot` (`set event.after`);
`draft/CanLeave.can:70` `calendar_changed` (`set event.after`);
`draft/CanOnboard.can:44` `template_changed` (`set event.after`);
`draft/CanVolunteer.can:45` `venue_on_create` (require only). All eight
hold verbatim under every alternative. (Out-of-scope boundary note:
`draft/CanVolunteer.can:47` `refresh_reminders on=Opportunity.updated
each=Signup` is a committed fanout handler, not a CRUD hook.)

### Cross-cutting gate notes (adopt NOTHING)

- D ≡ A on all current drafts: no CRUD hook exists on any staged-create
  target model (Transition, Notice, Cancellation, LocationPolicy,
  ResourcePolicy, WindowEvidence) — only `.created` committed handlers
  for Revision/Notice. No sampled or enumerated workflow needs cascade.
- R27 hook side stays 2 sites: `armed` hook writes occur only at
  `draft/CanCheck.can:99` (`initial`) and `:109` (`configured`); L58/L80
  `armed` writes are ordinary-path (non-hook) operations. Full
  server-owned-field cross-check remains gate item 3 (T18 rule).
- B-remodel burden is 36 bodies, not the 2 sampled in prep — including
  14 snapshot hooks with `sequence=count()+1` atomicity stakes and 8
  cross-row revision-bump/counter sets.
- Gaps no alternative addresses (for the JEV gate): bound `send` in hook
  bodies (Check:120, Discover:251), `emit` in hook bodies (5 sites),
  delete-hook non-target writes (Onboard:51), child-bound timer fan-out
  (Success:100-103).

### Commands run (read-only)

1. `ls draft/**/*.can draft/*.can | sort -u | wc -l` → 52 sources.
2. `rg -n --glob '*.can' "on\s*=\s*[A-Za-z0-9_]+.(create|update|delete)\b"
   draft/` → 44 CRUD hook declarations (16 files).
3. `rg -n --glob '*.can' -A 12 "scenario \w+
   on=[A-Za-z0-9_]+.(create|update|delete)\b" draft/` plus `-A 10` snapshot
   pass and direct file reads of CanCheck:85-135 (body-boundary
   verification for every hook).
4. `rg -n --glob '*.can' "scenario \w+
   on=[A-Za-z0-9_]+\.(create|update|delete)" draft/ -A 14 | rg
   "delete|archive|destroy"` → zero in-body delete attempts (only the
   `on=TemplateStep.delete` declaration line itself plus neighboring
   non-hook `archived=include`/`on=X.deleted` bleed-through).
5. `rg -n --glob '*.can' "scenario \w+
   on=(Transition|Notice|Cancellation|LocationPolicy|ResourcePolicy|
   WindowEvidence|...)\.(create|update|delete)" draft/` → no CRUD hooks
   on staged targets (D ≡ A).
6. `rg -n --glob '*.can' "armed" draft/` → hook-side R27 sites are
   CanCheck:99/:109 only.
7. `rg -c --glob '*.can' "scenario \w+ on=" draft/` → 295 total `on=`
   scenarios (44 CRUD hooks; remainder committed/fanout handlers).

### Handoff

- Writer: L3 T31a-enumeration. Single file appended
  (`implementation/challenge-audit-run/evidence/hook-decision.md` only);
  existing alternatives/fairness/checklist text untouched except the
  item-2 COMPLETE marker above; DESIGN.md/GRAMMAR.md/DECISIONS.md,
  drafts, code, tools/jev.py, tasks.md/monitor.md/inbox untouched (read
  or coordinator-owned); no JEV run; no Git.
- Release: this file is RELEASED to the coordinator for gate scheduling.

## T30-completion input (gate evidence)

Status: **PROPOSED / PREP — adopts NOTHING.** Checklist item 1 evidence
only; all alternatives stay unranked and every **JEV-PENDING** above is
preserved. Landed-record transcription from tasks.md T30 evidence plus
read-only code cites; no builds, no JEV, no Git.

### Landed T30 facts (tasks.md T30 evidence: T30 COMPLETE)

- Writer 01a10d37-ce26 released `types.rs` (spelling arm removed,
  resolution dispatch, path-head/context rules) + 16 `b4` tests
  (rename-invariance, verified-ref, snapshot/pending/hook controls) +
  table (16 down / 0 up).
- Coordinator stash-differential: 192 removed (E3009 -42, E3001 -137,
  E2001 -13); 11 added ALL proven genuine leaf findings in
  newly-reached `set event.*` targets (enum/datetime/opaque/secret
  negatives); residual E3009 x2 are legitimate immutable controls;
  suite 27 green.

### Read-only code verification (this survey)

- Binding-based dispatch, never head spelling:
  `path_head_is_context_event` matches
  `Binding::Context(ContextVar::Event)` via the resolve tables
  (`compiler/src/analysis/types.rs:1323-1332`), called at
  `:1285-1286`. No spelling-conditioned mutation arm remains on that
  path.
- Resolution dispatch (`event_mutation_target`, `:1342-1377`):
  `event.after` adjusts the pending record; `event.before` is
  read-only; a path resolving to a stored model record (verified
  declared reference such as `event.check`, or a live row reached
  through payload members) mutates on its own provenance; the whole
  payload, opaque members and value data are E3009.
- Hook-payload side typing (C6 repair, `hook_payload_side`,
  `:1440-1447`, applied at `:9502` and `:10058` with
  receiver-must-resolve-to-context-event guards): in a create/update
  hook, `event.after`/`event.before` carry the hooked model's record
  instead of `{opaque}`. On create `before` is null; on delete `after`
  stays opaque; all other members stay opaque (`None`).
- Tests: `t30_*` cases in `compiler/tests/b4_check.rs` (rename
  invariance, verified-reference acceptance, snapshot/pending/delete
  controls, after/before typing).

### Settled vs open for the gate

- CONFIRM (settled): renaming `event` changes no validity — the T30
  acceptance criterion, coordinator-verified. Ordinary parameters
  (CanEvent L73) and verified declared references (CanAffiliate
  partner/settlement, CanCheck:128 `event.check`) are not snapshots.
- CONFIRM (settled): the C6 root cause — incomplete `Check.create`
  after/before payload typing — is repaired at the type rule:
  create/update hook bodies now read and `parent=event.after`-check
  against the real record. The gate's bar items 1-5 all concern
  create/update hooks (43 of 44 enumerated bodies), so no alternative
  is judged through payload opacity.
- QUALIFY: the Check:99-100 per-site diagnostic state was not re-run
  in this read-only survey (no build); resolution there is inferred
  from the landed rule plus the coordinator's corpus E3001 -137
  differential, not re-observed line by line.
- OPEN (residue, gate-scoped): delete-hook `after` stays opaque by
  the landed rule. It touches only the already-flagged Onboard:51
  delete-hook parent-row gap, which no alternative addresses — it does
  not confound any A/B/C/D bar item.
- ABSENT: no remaining payload-typing work blocks the gate.
  Left-over `{opaque}` leaves (deployment-bound recipes, undeclared
  members, delete-hook `after`) are genuine by the T30 differential,
  not clusters.

## Durable-transaction evidence plan (gate evidence)

Status: **PROPOSED / PREP — adopts NOTHING.** Checklist item 6 evidence
only; a PLAN, not proof. All alternatives stay unranked and every
**JEV-PENDING** above is preserved. Grounded in a read-only survey of
the state engine plus T16/T17/T24 runtime status in tasks.md; no
builds, no JEV, no Git.

### Surveyed substrate inventory (read-only)

- Fenced single-shot commit: `TransactionPort::commit(batch)` over one
  store, no retry (`packages/state/src/ports/transact.ts`); stale
  fences surface as retryable `busy` via `storageToStateError`.
- One atomic batch shape: `CommitBatch { expectedRevision, writes,
  history, receipt, outbox, schedules, uniqueClaims, ... }`
  (`packages/contracts/src/state.ts:281-298`).
- D1 adapter: every commit is ONE `db.batch()` led by a `fence_log`
  INSERT (`expected+1`), so a stale `expectedRevision` fails
  atomically with nothing applied
  (`packages/state/src/storage/d1.ts` header).
- DO adapter: same fence semantics through synchronous `storage.sql`
  inside `storage.transactionSync`, which rolls back on throw
  (`packages/state/src/storage/durable-object.ts` header).
- Memory adapter: header-marked TEST-ONLY, never a production
  backend; mirrors fence/constraint/query semantics for unit tests
  (`packages/state/src/storage/memory.ts` header).
- Hook execution today: `runHooks` runs matching hooks in written
  order with clone-in/clone-out candidates
  (`packages/state/src/mutation/pipeline.ts:300-327`); no
  staged-secondary-write, cascade, or cross-row staging machinery was
  found in this survey — that is post-gate T31 work.
- Runtime status in tasks.md: T16, T17, T18, T24 all OPEN with
  "Evidence: pending" — no generated-invocation join, no canonical
  data-plane migration, no durable dispatch exists yet. This plan is
  therefore conditional on T16/T17 landing, which T31 already
  requires; it says where each alternative's proof must run, not that
  the substrate is ready.

### Per-alternative proof map (which proof runs where)

- Alternative A (staged same-transaction): atomic rollback —
  trigger + staged set committed as ONE `CommitBatch` on D1
  (`db.batch`) AND DO (`transactionSync`); a failing staged invariant
  must void the trigger with zero partial rows. Version conflict —
  two concurrent committers against D1/DO; the loser gets a fence
  conflict (`busy`), never a silent overwrite. Revision invalidation
  — every staged write enrolls its target's read revision; an
  intervening commit to any staged target aborts the whole batch on
  D1/DO.
- Alternative B (after-only + committed handlers): trigger-only fence
  proof on D1/DO (single-row batch) PLUS handler retry/recovery proof
  on the T24 dispatch substrate (outbox intents, receipts, redelivery
  identity). The orphaned-parent gap (trigger committed, handler
  failed) must be demonstrated and recovered on T24 machinery —
  never hand-waved. Handler re-read guards may be unit-proven; their
  durability may not.
- Alternative C (declared allowlist): everything in A, run on the
  same D1/DO substrates, PLUS allowlist enforcement proven
  statically: undeclared staged writes rejected by checker tests
  (substrate-independent), and the staged set auditable from the hook
  signature in review evidence.
- Alternative D (bounded cascade): everything in A extended over the
  cascade on D1/DO, PLUS the depth bound proven at runtime (bound
  trip fails the operation on D1/DO, not in memory) and cascade
  order/conflict-interleaving tests on D1/DO. Static cycle rejection
  proven by checker tests.
- Crash-recovery (A/C/D atomic claims, B handler claims): kill/restart
  mid-commit against local D1 (workerd/miniflare) and DO SQLite;
  `fence_log` must show no partial batch, and B-handlers must resume
  from receipts/outbox. No crash claim may rest on the memory store.
- Concurrent-transaction interleaving: two live committers racing one
  row on D1/DO adapters; exactly one fence INSERT wins. The memory
  store is single-threaded and proves no interleaving.
- Cross-authority partial failure: T24 outbox/dispatch substrate
  only. Single-owner batch atomicity never implies cross-store
  atomicity (T24 acceptance already forbids inferring it).

### What memory-store tests may and may not claim

- MAY claim: deterministic unit semantics — batch shape, staged-write
  ordering, fence/conflict error mapping, replay-shape and receipt
  identity, static negatives (recursion/deletion/snapshot bans),
  guard logic.
- MAY NOT claim: durability, atomicity under crash, fencing under
  real concurrency, interleaving outcomes, cross-authority behavior,
  or anything the item-6 checklist text names as a D1/DO property.
  Any T31 proof citing memory-store results for those properties is
  miscategorized evidence, not a pass.

### Handoff

- Writer: L3 T31a-gate-inputs. Single file appended
  (`implementation/challenge-audit-run/evidence/hook-decision.md` only);
  existing alternatives/fairness/enumeration/checklist text untouched
  except the item-1 and item-6 markers above; DESIGN.md/GRAMMAR.md/
  DECISIONS.md, drafts, code, tools/jev.py, tasks.md/monitor.md/inbox
  untouched (read or coordinator-owned); no JEV run; no Git.
- Release: this file is RELEASED to the coordinator for gate scheduling.

## T28-ownership input (gate evidence)

Status: **PROPOSED / PREP — adopts NOTHING.** Checklist item 4 evidence
only; all alternatives stay unranked and every **JEV-PENDING** above is
preserved. Transcription of the ADOPTED T28 Alternative A rule (the
settled half) plus the owed-T29 boundary (the absent half) from
tasks.md; read-only survey, no builds, no JEV, no Git.

### Settled half (CONFIRMED): the ADOPTED T28-A rule

Gate outcome (containment-decision.md "JEV outcome", tasks.md T28
evidence: T28 COMPLETE): unanimous ADOPT of Alternative A,
`plain_import_containment`, 3/3 consultations, model jev-1.13.0. For
staged hook writes touching imported references, the adopted rule
settles:

- Declaring identity: the child keeps its declaring package identity
  (e.g. `expense.Expense`); only the parent type is imported
  (containment-decision.md Alternative A; JEV outcome: "Declaring
  identity stays with the child package").
- Plain = same deployment: a parent arriving via a plain (non-bound)
  import is included in the selected app, so owner transaction rules
  apply — parent and cross-package children sit at the same storage
  owner in the same store, inside one atomic owner commit at spec
  level (Alternative A local/remote clause; DESIGN.md:81/:95/:338
  via the storage-atomicity survey; JEV outcome: "plain import =
  same deployment with owner transaction rules").
- Authority unchanged: child CRUD owned by the declaring package;
  parent package policy still governs parent rows; the consumer
  cannot mutate the parent or extend its policy (Alternative A
  parent/storage/authority clause — existing package rule).
- Bound rejected: a bound (`from=deployment...`) parent is rejected
  as a containment target with a diagnostic; authors use a reference
  field instead (Alternative A rule; JEV outcome: "bound (`from=`)
  parents stay rejected"). Zero draft sites use bound parents
  (containment item-2 evidence: 20/20 plain, 76-`from=` census), so
  the rejection clause is untested by draft evidence in both
  directions — stated as rule, not as observed intent.
- Reverse/cycle/lifecycle shape (spec-level): `parentRecord.Child`
  typed collection through the whole-app index, readable only where
  child policies grant; containment-cycle detection runs over the
  whole-app index (cross-package cycles are errors); subtree
  archive/delete spans the shared store atomically (Alternative A
  clauses).
- Retained caveat (B opposing case, NOT waived): cross-package
  subtree coupling — a consumer's delete/archive cascade touches
  owner-adjacent children and a future deployment split silently
  breaks the atomicity promise (Alternative A opposing case; JEV
  outcome standing obligations: "B's coupling objection is the
  retained opposing case for T29 review").

### Owed half (ABSENT-with-reason): T29 implementation

T29 has NOT started: tasks.md T29 reads "Evidence: pending", depends
on accepted T28 plus matching T15/T16/T17, and T16/T17 are themselves
OPEN with "Evidence: pending". Nothing below is implemented
behavior; no T29 claim may be treated as landed. Precisely owed:

- Atomicity proof (engine): same-store atomic cross-package subtree
  commits. Spec says YES (one owner, one store, one fenced batch;
  containment storage-atomicity survey CONFIRMED), but the engine is
  UNPROVEN — delete archives one row, not a subtree
  (`mutation/crud.ts`, `mutation/pipeline.ts`); zero `cascad*` hits
  in state engine/contracts; generated operations still commit
  through the B1 interim path (`runtime/stdlib.ts`,
  `runtime/invoke.ts`). Standing obligation per the JEV outcome and
  tasks.md T28 evidence: T29/T16/T17 must prove it.
- Split diagnostic (checker/deploy): what fires when A/D packages
  split into separate deployments. Specified failure
  (reject-before-commit or orphan-by-topology, DESIGN.md:549/:547/
  :89) but ABSENT enforcement — E2008 rejects imported containment
  wholesale today, E4040/E4051 key on bound-vs-local and scope, not
  topology, and the migration plan asserts no store-sharing
  (storage-atomicity survey). Standing obligation per the JEV
  outcome: "a deployment-split diagnostic is owed".
- Applicability mapping: this survey states the rule conditionally
  (IF a staged write touches an imported reference, THEN the above
  halves apply) and does not re-adjudicate which of the 44
  enumerated hook bodies touch imported references — that mapping is
  T29/T31-implementation scope, not gate evidence.

### How each hook alternative inherits the halves

- Alternative A (staged same-transaction): inherits the settled half
  for any staged write naming an imported containment relationship —
  same-deployment placement, declaring-package CRUD ownership, no
  parent-mutation authority, bound targets rejected. Inherits the
  owed half in full: A may not claim staged trigger+children
  atomicity over imported subtrees until T29 proves it on D1/DO, nor
  split safety until the diagnostic lands. A's failure-coupling
  opposing case now composes with the retained T28 coupling caveat:
  a staged write into an imported subtree can fail the user's
  trigger across a package boundary.
- Alternative B (after-only + committed handlers): stages nothing,
  so the settled half applies only to committed-handler references
  (handlers creating children under imported parents or reading
  `row.parent.*`) — same placement/authority/bound-rejection rule.
  B avoids the owed staged-atomicity proof on the trigger path but
  does NOT escape T29: handler-side containment writes still need
  T29 checking/storage behavior, and the orphaned-parent gap must be
  analyzed with imported parents in view. B's 36-body remodel burden
  is unchanged by T28.
- Alternative C (declared allowlist): identical to A for allowlisted
  parented-children/pending-bound timers that touch imported refs —
  same settled placement/authority, same owed atomicity + split
  proofs. The allowlist is a staging gate, not a T29 substitute: an
  allowlisted write under an imported parent still needs the engine
  proof. C's as-written `parent=event.after` vs
  `parent=event.after.parent` boundary question is orthogonal to T28
  and stays **JEV-PENDING**.
- Alternative D (bounded cascade): identical to A, extended over any
  cascaded hook that touches imported refs; owed proofs grow with
  the cascade (same D1/DO scope as the durable-transaction plan).
  D ≡ A on current drafts (no hooks on staged targets), so T28 adds
  no new cascade evidence today.

### Verdict for item 4

**QUALIFIED**: T28 half CONFIRMED (adopted rule transcribed with
cites above); T29 half ABSENT-with-reason (implementation not
started, prerequisites T15/T16/T17 open). The gate may judge hook
alternatives against the settled placement/authority/bound-rejection
rule, but no alternative may claim proven staged-or-handler
containment execution over imported references — that proof is
T29/T16/T17 work, and T28 alone remains insufficient per the T31
brief (plan T31 task; tasks.md T31 prerequisites; this file's scope
note).

### Commands run (read-only)

1. Full `read_file` of `hook-decision.md` (alternatives, fairness,
   checklist, enumeration, T30 record, durable plan).
2. Full `read_file` of `containment-decision.md` (alternatives A–D,
   fairness, all gate evidence, JEV outcome adopting A).
3. `read_file` of tasks.md T28 COMPLETE evidence + T29/T31 status
   (T29 "Evidence: pending"; T16/T17 OPEN).
4. `search` for T31a/T31 dependency lines in
   CHALLENGE-AUDIT-PLAN.md (T28 alone is insufficient; T31 depends
   on applicable T28/T29).
5. Post-edit verification greps (markers, section list) — exits
   recorded in the return report, not here.

### Handoff

- Writer: L3 T31a-item4. Single file appended
  (`implementation/challenge-audit-run/evidence/hook-decision.md` only);
  existing alternatives/fairness/enumeration/checklist text untouched
  except the item-4 marker above; DESIGN.md/GRAMMAR.md/DECISIONS.md,
  drafts, code, tools/jev.py, tasks.md/monitor.md/inbox untouched
  (read or coordinator-owned); no JEV run; no Git.
- Release: this file is RELEASED to the coordinator for gate scheduling.

## R27/T18 rule input (gate evidence)

Status: **PROPOSED / PREP — adopts NOTHING.** Checklist item 3 evidence
only; all alternatives stay unranked and every **JEV-PENDING** above is
preserved. Read-only transcription of what R27 and T18 actually say;
no builds, no JEV, no Git.

### Verdict for item 3

**QUALIFIED**: R27 half CONFIRMED (a T01 ledger root exists; text
transcribed verbatim below with
`implementation/challenge-audit-run/evidence/root-causes.md:524-541`
refs). Adopted-T18-rule half ABSENT: T18 is OPEN with
"Evidence: pending" (`implementation/challenge-audit-run/tasks.md:182`),
so no adopted default/server/update/hook rule exists for the gate to
apply. The gate may judge alternatives against R27's recorded
rule-shape plus the settled DESIGN/T04a sentences below, but the
"adopted T18 rule" the checklist names does not exist yet. Every
alternative's Server-owned-fields **JEV-PENDING** is therefore
preserved, not resolved. (Checklist marker above left for the
coordinator: this writer's reservation is append-only.)

### What was searched (absence record for an adopted rule)

- `R27` in `implementation/CHALLENGE-AUDIT-PLAN.md` → zero hits. In
  `implementation/challenge-audit-run` → this file (transcription +
  per-alternative rows), `evidence/app-intent.md:124` (CanCheck
  disposition), `evidence/root-causes.md:524-541` (ledger entry) +
  `:632` (routing `R27 T18+T31`), `tasks.md:273` (T31a gate-needs
  line). No adopted rule text anywhere in the hit set.
- `T18` in the plan → scope rows `:101` (L2 values/creation),
  `:121/:126/:133` (critical path), `:172/:174` (dependents),
  `:196` (port map), `:282/:354` (backlog mentions), `:468`
  (L2/L1/L3 join), `:476` (task text, quoted below); in tasks.md →
  `:177-182` (OPEN, Evidence pending) plus dependent/prerequisite
  mentions. No landed rule, no JEV, no evidence.
- `server=|server-owned|serverOnly` in `DESIGN.md`/`DECISIONS.md` →
  `DESIGN.md:129/:131/:332/:403/:435`,
  `DECISIONS.md:177/:619/:728`. Settled sentences quoted below; none
  names hook bodies.
- Result: R27 exists as a bucket-**b** T01 root owned by T18+T31
  (root-causes.md:533/:632), not as an adopted rule. Nothing found
  was invented; nothing absent is treated as present.

### Rule 1 — R27 ledger entry (verbatim, root-causes.md:524-541)

> ### R27 — inconsistent server-owned enforcement, `armed` (E3001)
> - Sites: `CanCheck.can:58`
>   `set check {enabled=true,...,armed=now,...}` in `resume` —
>   `server-owned field 'armed' cannot be set`; contrast L99
>   `set event.after {armed=now,...}` in the `Check.create` hook,
>   which draws no such diagnostic.
> - Intent: re-anchor the deadline when resuming a paused check.
> - Root: server-owned enforcement differs between the ordinary-update
>   path and the hook path; one rule must cover creation defaults,
>   server initialization, updates, and hooks.
> - Bucket: **b**. Owner: L2/L3 with L1 emission, T18 + T31.
> - Opposing: `server=now` may mean runtime-stamped and never
>   author-settable, in which case resume needs a supported re-anchor
>   mechanism rather than a direct write (then the hook side is the
>   hole to close).
> - Confidence medium. Flip: an adopted default/server/update/hook
>   rule assigning `armed` writes to exactly one mechanism.
> - Positive: actual creation/null/parent/actor/time/replay cases
>   agree on one rule. Negative: update omission vs explicit null,
>   protected fields, and replay-once behavior stay enforced.

Map to A-D (symmetric; supports/constrains/kills none
differentially): the "one rule must cover ... updates, and hooks"
sentence constrains all four alternatives equally — each
alternative's Server-owned-fields row already inherits the identical
**JEV-PENDING** (this file). If the gate adopts the opposing reading
(runtime-stamped, hook side is the hole), the CanCheck:99/:109
`set event.after {armed}` carve-out closes under EVERY alternative
and `resume` needs a re-anchor mechanism under EVERY alternative. If
the gate adopts the flip the other way (hooks may write
server-owned fields the ordinary path rejects), L99/L109 stand as
written under EVERY alternative. R27's subject is settled-core
`set event.after`, not secondary writes, so it cannot discriminate
staging (A) from after-only (B) from allowlist (C) from cascade
(D).

### Rule 2 — T18 task text (verbatim; OPEN, no adopted content)

- Plan (`implementation/CHALLENGE-AUDIT-PLAN.md:476`): "**T18 Execute
  defaults and server initialization correctly.** Accountable lead:
  L2; L3 owns runtime execution and L1 emission. Depends on
  T09/T16/T17. Preserve context/order, update omission and protected
  fields. Done when actual creation/null/parent/actor/time/replay
  cases agree."
- tasks.md (`implementation/challenge-audit-run/tasks.md:177-182`):
  same lead/depends; Acceptance: "Create/default/null/parent/
  actor/time evaluation order, update omission/protected fields and
  replay once agree in actual generated execution, not
  descriptor-only tests."; Evidence: pending.
- Join context (plan `:468`): "L2 defines and verifies exact
  values/input meaning once. L1 performs Rust and emission changes
  for T09-T11, and L3 performs canonical runtime execution for T18.
  Completion requires their joined evidence."

Map to A-D: contributes no adopted content, so it supports,
constrains, and kills none. The "update omission and protected
fields" phrase is the closest stated hook-adjacent constraint, but
it names no hook or secondary-write behavior. T18's own
prerequisites T16/T17 are themselves OPEN (item-6 survey, this
file), so the adopted rule is at least two landings away.

### Rule 3 — DESIGN settled sentences (verbatim; read-only here)

- `DESIGN.md:129`: "`name:T server=expr` supplies the server value on
  creation and excludes it from client inputs. `secret` fields
  always require server initialization."
- `DESIGN.md:131` (relevant clause): "Nullable, defaulted and
  server-owned fields retain their existing creation behavior;
  partial updates still distinguish an omitted change from explicit
  null."
- `DESIGN.md:332` (relevant clause, CRUD admission): "Prepare
  defaults and server-owned fields without staging this write,
  evaluate the predicate, then stage only on acceptance."
- `DESIGN.md:518` (relevant clauses, hook contract): "can reject or
  adjust it, and cannot introduce new client parameters." /
  "`set event.after {fields}` adjusts the pending create/update
  record without recursively invoking CRUD" / "They cannot call
  back into the triggering CRUD."

Map to A-D: the server/default sentences govern creation and
ordinary CRUD admission; none names hook bodies, so all four
alternatives inherit them identically (supports/kills none). One
neutrally stated asymmetric proof obligation: under A/C/D the gate
must say when defaults/server prep (DESIGN:332) runs for each
staged secondary write; under B there are no staged writes, so
that sentence adds no hook-side obligation — but B's committed
handlers are ordinary-path operations where it applies in full.
The no-new-client-parameters and no-callback sentences are the
settled ancestors of every alternative's recursion/negative bans
(bar item 5, this file); no alternative proposes new parameters.

### Rule 4 — T04a frozen descriptor vocabulary (execution-contract.md:68-73)

Verbatim (`implementation/challenge-audit-run/evidence/
execution-contract.md:68-73`, T04a FROZEN per tasks.md:414):
"`CanonicalFieldDef`: required, serverOnly (caller-supplied values
rejected), ordinary-vs-required array marker ... and default
vocabulary." / "`CanonicalFieldDefault`: `literal` | `parent` ...
| `server` | `derived`. `server`/`derived` exclude the field from
writable inputs; T18 owns their execution."

Map to A-D: ordinary-path admission only (caller inputs), silent on
hook bodies — consistent with R27's observed asymmetry (ordinary
path rejects, hook path unchecked) without resolving it. Symmetric
across A-D; kills none. The T04b remainder explicitly lists
"hook / invariant / lock descriptor joins" as not done
(execution-contract.md:146-147; tasks.md:83), so no descriptor rule
covers hook-side `server` writes yet.

### Site census grounding (R27's two sides)

- Declaration: `draft/CanCheck.can:15`
  `armed:datetime server=now` (and `token:secret
  server=random_secret()`; no `token` write appears in the
  CanCheck:96-121 hook bodies — direct read).
- Hook side: `armed` writes occur only at `draft/CanCheck.can:99`
  (`initial`) and `:109` (`configured`) — enumeration survey (this
  file) corroborated by direct read of CanCheck:96-121.
- Ordinary side: `draft/CanCheck.can:58` (`resume`) and `:80`
  (`ping` handler) — non-hook operations (this file).
- **UNVERIFIED** (no build in this read-only survey): R27 records
  L58 rejected vs L99 accepted pre-T30; T30 landed after with a
  corpus E3001 -137 differential (item-1 record, this file). Whether
  L58 still rejects today needs a coordinator-owned checker re-run;
  the gate must not assume the recorded diagnostic state is
  current.

### Per-alternative inheritance (fair; no ranking)

- A: inherits R27's question on its settled-core `set event.after`
  plus the DESIGN:332 prep-timing proof obligation for each staged
  write. Nothing in Rules 1-4 bars staging.
- B: inherits the identical R27 question on its (narrower)
  settled-core `set event.after`; DESIGN:332 applies to its
  committed handlers as ordinary operations. Nothing in Rules 1-4
  mandates the after-only split.
- C: identical to A for allowlisted writes; Rules 1-4 say nothing
  about allowlists, so none supports or bars the declared boundary.
- D: identical to A; Rules 1-4 say nothing about cascades.
- Net: item 3 contributes zero differential evidence among A-D. All
  four keep their Server-owned-fields **JEV-PENDING**.

### Commands run (read-only)

1. `R27` search in CHALLENGE-AUDIT-PLAN.md (zero hits) and
   challenge-audit-run (4 files, refs above).
2. `T18` search in plan + tasks.md + evidence (refs above).
3. `server=|server-owned|serverOnly` search in DESIGN.md/DECISIONS.md
   (5 + 3 hits, refs above).
4. Direct reads: root-causes.md:524-541, tasks.md:177-182,
   plan:464-476, execution-contract.md:51-73 + :144-150,
   CanCheck.can:1-30 + :50-121, DESIGN.md:125-135.

### Handoff

- Writer: L3 T31a-item3. This section appended only; prior
  alternatives/fairness/checklist/enumeration/records untouched
  (checklist item-3 marker left for the coordinator per the
  append-only reservation). DESIGN.md/GRAMMAR.md/DECISIONS.md,
  drafts, code, tools/jev.py, tasks.md/monitor.md/inbox untouched
  (read or coordinator-owned); no JEV run; no Git.
- Release: this file is RELEASED to the coordinator for gate scheduling.

## T23 example-contract input (gate evidence)

Status: **PROPOSED / PREP — adopts NOTHING.** Checklist item 5 evidence
only; all alternatives stay unranked and every **JEV-PENDING** above is
preserved. Read-only survey of T23 status, the R29 flip, and concrete
draft example inputs; no builds, no JEV, no Git.

### Verdict for item 5

**QUALIFIED gap with usable inputs**: (a) T23-executed inputs are
ABSENT — T23, T22, T21 are all OPEN with "Evidence: pending", so no
compiled example has ever executed and no observation below was ever
observed passing/failing; (b) concrete draft-source example inputs
EXIST — 2 discriminating blocks plus 8 control/contract/analogy
inputs, all with file:line refs and per-alternative maps below;
(c) the R29 contract flip is OPEN — T04a §5 settles committed-state
observations but does not name input-alias observations or
committed-handler scope. The gate may use the draft inputs as
proof-test candidates, but every discrimination map is derived from
draft text + contract text, not from execution. (Checklist marker
above left for the coordinator: this writer's reservation is
append-only.)

### Absence record (T23-executed inputs — what exists, what is missing)

- EXISTS (plan/task text, no execution):
  `implementation/challenge-audit-run/tasks.md:212-217` — T23 OPEN,
  "Prerequisites: matching T22a/b/c and T04 emitted-example
  contract", "Done only when the full promised calls/callers/prior
  commits/independent observations/rejection/no-change assertions
  execute and deliberately broken expectations fail", "Evidence:
  pending". T22 (`tasks.md:205-210`) and T21 (`tasks.md:198-203`)
  are likewise OPEN with "Evidence: pending".
- EXISTS (agreed contract slice): T04a FROZEN
  (`tasks.md:414`), including §5 emitted-example rules
  (`evidence/execution-contract.md:92-110`, quoted below).
- MISSING: T04b remainder — "hook / invariant / lock descriptor
  joins", "file/progress/receipt observation extensions"
  (execution-contract.md:144-150; tasks.md:83). The contract half a
  hook-behavior example needs is explicitly remaindered.
- MISSING: any executed compiled table/sequence anywhere (T23a
  follows T22a, which needs T15a/T16/T17 — T16/T17 OPEN per the
  item-6 survey, this file). Consequence: all maps below are
  draft-text derivations. Any T31 proof test built from these
  inputs is T23a-scope work.

### Contract half: R29 + T04a §5 (verbatim)

R29 (`evidence/root-causes.md:562-579`):
> ### R29 — example input-vs-observation attribution (E5002)
> - Site: `CanLeave.can:136` examples header for `decide`:
>   `as,request.parent.parent.user,... -> request.state,...` —
>   `unknown field 'parent' on Calendar` and `'request' is an input,
>   not an observation`.
> - Root: unclear attribution between input bindings and post-call
>   observations (is observing through the input binding allowed, or
>   must observations reload stored state?), plus a possible
>   Calendar `parent` selector gap (T08-adjacent).
> - Bucket: **c/b** unresolved — recorded as **c** pending T23
>   semantics. Owner: L7 T23 with draft owner T36.
> - Opposing: observations must read reloaded isolated stored state;
>   input aliases may be stale or ambiguous, so rejecting them could
>   be correct (bucket a reading).
> - Confidence low. Flip: the adopted emitted-example contract
>   explicitly allows or forbids input-alias observations.

T04a §5 (`evidence/execution-contract.md:92-110`, frozen):
> - Examples execute through production admission against compiled
>   artifacts only; `ExampleReport.artifact` pins digest + source
>   revision.
> - Each row/sequence step runs in an isolated fixture scope with
>   its own caller (`ResolvedCaller`); setup failures report
>   `setup-failed` and can never satisfy an expected business
>   rejection.
> - Expected values are independently authored ... and compare with
>   L2 exact-value semantics via wire encoding ...
> - State observations (`ExampleStateObservation`) read committed
>   state only, through authorized viewer-projection queries at the
>   committed fence revision. Owner/authority reads never serve an
>   example observation.
> - Rejection rows expect an exact error code plus a no-change proof
>   ...; later sequence steps keep earlier commits and add no new
>   effects on rejection.
> - Falsifiability: altering an expected value, removing a call, or
>   suppressing a write must fail the relevant test.

DESIGN fixture/execution sentences (`DESIGN.md:403`, relevant
clauses): "Model fixtures describe typed **stored snapshots**, not
client create requests" / "Snapshot construction does not invoke
CRUD hooks or emit business events" / "the runner ... invokes the
registered operation exactly once through its normal
authorization/validation/commit path."

Settled vs open: SETTLED — observations read committed state via
viewer-projection queries at the committed fence revision; setup
failures never satisfy rejections; falsifiability. OPEN
(**JEV-PENDING**) — (i) the R29 flip itself: §5 never names input
bindings, so whether `request.state`-style input-alias
observations are allowed is undecided; (ii) whether committed
handlers (B's secondaries) execute inside an example's observation
scope — neither §5 nor DESIGN:403 names handlers, so under B it is
undecided whether a trigger-commit observation sees handler
effects.

### Concrete input 1 — DISCRIMINATING: Plan-update examples (CanMaintain:81-90)

Shape (attached to `crud Plan`, `draft/CanMaintain.can:80`; update
invokes the `revise_plan` hook at `:98-105`, which does `set
event.after {revision,asset_epoch}` + `create Cancellation
{parent=event.after.parent,...}` + `emit CancellationStep` +
`cancel`/`schedule`):

> L81 `examples update seed=[test_worker,check] record=recurring`
> L82 `as,changes.name -> recurring.revision,check.cancelled,check.result,inspection_pending(check),count(equipment.Cancellation)`
> L83 `maintenance_manager,"Revised cooling check" -> 2,false,pending,false,1`
> L84 `technician,"Revised cooling check" -> error(forbidden)`
> L85 `examples update seed=[test_worker,technician_employee] record=recurring`
> L86 `as,changes.active,changes.assignee,equipment.retired -> recurring.revision,count(equipment.Cancellation)`
> L87 `maintenance_manager,true,inspection_technician,false -> 2,1`
> L88 `maintenance_manager,true,other,false -> error(rule_failed)`
> L89 `maintenance_manager,true,inspection_technician,true -> error(rule_failed)`
> L90 `maintenance_manager,false,other,true -> 2,1`

Seed grounding: the `Cancellation` fixtures (`superseded`,
`retired_work`, L76-77) are NOT in either seed list, so the
`count(equipment.Cancellation)` observation starts at 0 and the
expected `1` is exactly the hook-created child — derived from the
seed lists plus DESIGN:435 seed-closure loading, **UNVERIFIED** by
execution.

Map (discriminates all pairs except A/D): A — the staged child
commits atomically with the trigger, so the committed-state
observation sees `1` as written (modulo the `emit`/timer scope
proofs, which no alternative addresses — this file). B — the child
exists only after a later committed handler, so a trigger-commit
observation sees `0` and the rows fail as written UNLESS the
example scope runs handlers (open per (ii) above —
**JEV-PENDING**). C-as-written — `parent=event.after.parent` is
outside the `parent=event.after` allowlist, so the staged create
is a check-time rejection and the rows fail as written; holds only
if the gate extends the allowlist (the gate question the
enumeration already flagged — this file). D — identical to A here
(no `Cancellation` hooks exist — this file). The `error(...)`
rows fail at admission before the hook runs, so they are
identical under all four (controls).

### Concrete input 2 — CONTROL (hook behavior, no discrimination): Suggestion examples (CanFeedback:58-72)

Shape (attached to `crud Suggestion`, `draft/CanFeedback.can:57`;
create/update invoke the settled-core hooks `contribution_limit`
`:76-77` (require) and `review_edited` `:79-80` (`set
event.after {hidden=true,...}`)):

> L58 `examples create parent=product title="Air quality" ...`
> L59 `as,parent.published -> count(product.Suggestion),count(...)`
> L60-62 `members,true -> 1,0` / `members,false -> error(rule_failed)` / `public,true -> error(forbidden)`
> L63 `examples create seed=[recent,...5] ...` L64-65 `members -> error(rule_failed)` (hook require: 6th suggestion in the hour)
> L66 `examples update record=suggestion` L67 `as,changes.title,record.author -> suggestion.title,suggestion.hidden`
> L68 `members,"More booths",self -> "More booths",true` (hook set observed: fixture `hidden=false` at L37, post-update `true`)
> L70-72 `examples delete record=suggestion` → `true` (no Suggestion delete hook exists — hook-free control)

Map: identical under A-D (settled core behaves the same in every
alternative) — regression controls any adopted alternative must
keep passing, not discriminators.

### Concrete inputs 3-5 — CONTRACT (R29 flip; no hook triggered; identical relevance under all A-D)

3. `draft/CanCheck.can:60-64` (`resume` examples): header L61
   `as,check.enabled,check.state -> check.enabled,check.state,check.armed,check.due,check.revision`
   observes the server-owned R27 field `check.armed` THROUGH the
   input binding `check` (row L62 `...,now,now+5m,2`). This is the
   R29 input-alias question instantiated on the R27 field: the R29
   ruling directly decides whether hook-behavior examples may use
   this observation style. Caveat: the L58 trigger row is R27's
   ordinary-path rejection site — executability **UNVERIFIED**
   (no build).
4. `draft/CanLeave.can:135-138` (`decide` examples — the R29 site
   itself): header L136 `as,request.parent.parent.user,request.reviewer,reviewer_worker.user,allowance_2099.days -> request.state,allowance_2099.remaining,request.sync`
   with input-alias observations `request.state`, `request.sync`
   (row L137 `... -> approved,0,pending`). `decide` triggers no
   hook (no Request hooks in the 44-body census — this file).
5. `draft/CanDiscover.can:277-280` (`review` examples): header L278
   `as,test_worker.active,request.evidence.version -> result.evidence`
   observes through the `request` input alias (rows L279-280).
   Triggers no hook.

### Analogy input — child-count observation shape (CanCheck:82-89, no CRUD hook)

`ping` examples observe `count(heartbeat.Notice)` /
`first(heartbeat.Notice)?.outcome` after a committed-event handler
(`on=Pings.received`, L65). `ping` is not a CRUD hook, so this
discriminates nothing directly — but under B, hook secondaries
become exactly this kind of handler, making `ping` the closest
draft precedent for B-style observation vocabulary (still
unexecuted; T23 pending).

### Hook-free CRUD controls (corpus census)

Corpus-wide `examples create|update|delete` census (26 blocks):
CanTrade:37, CanTable:41/46/51/54/59/63, CanApprove:87, CanCRM:48,
CanBoard:41/46/52, CanMail:87/95, CanMaintain:81/85, CanOnboard:38/41,
CanDesk:57, CanGrant:76, CanShift:97/100, CanFeedback:58/63/66/70,
CanInvoice:274/280. Only CanMaintain (secondary-effect hooks) and
CanFeedback (settled-core hooks) attach to hook-carrying models;
the rest (Roster, Step, Table, Booking, Document, Prospect,
Meeting, Delegate, Conversation, Application, Invoice/Line)
attach to hook-free models — regression controls that discriminate
nothing. CanCheck has no `crud` declaration at all (verified by
the crud-decl census over the 16 hook files), so no CRUD-example
path reaches the Check hooks.

### Absence record (draft-source gaps — exact)

- ZERO `examples` blocks attach to any of the 44 hook scenarios:
  the examples-line census vs the scenario-line census over all 16
  hook files shows hook bodies contain no `examples` line; the
  nearest examples always attach to neighboring ordinary/handler
  scenarios (e.g. Member:246 attaches to `term` at :232, not the
  hook at :229; Leave:92 attaches to `preview` at :81, not the
  hooks at :70-78; Discover:272 attaches to `review` at :267, not
  the hook at :247; Check:138 attaches to `deadline` at :122, not
  the hooks at :96-121).
- ZERO examples on crud TemplateStep (cross-row hooks),
  Availability (emit hooks), FollowUp/Account/Obligation (timer
  hooks), Resource/Window/DayCalendar (snapshot hooks), Evidence
  (send + cross-row hook), Employee, Membership, Template
  (CanCreative), Contact, Asset.
- `draft/shared/Locations.can` and `draft/shared/Employees.can`
  contain zero `examples` lines at all (rg census) — no example
  input reaches the 14 snapshot-hook bodies or the Employee emit
  hook.

### Per-alternative proof-input map (fair; no ranking)

- A: input 1 proves atomic trigger+child as written (plus
  `emit`/timer scope rulings still owed); input 2 holds as
  controls. Needs T23a execution.
- B: input 1 as written is B's hardest case (`count=1` at trigger
  commit contradicts after-only unless handlers run in example
  scope — **JEV-PENDING** per open point (ii)); B's proof
  additionally needs the orphaned-parent recovery demo on T24
  machinery (item-6 plan, this file). Input 2 holds.
- C: input 1 fails C-as-written (trigger-parent parenting outside
  the allowlist) — the gate must extend the allowlist or accept
  B-remodel for this body; no other input changes that question.
  Input 2 holds.
- D: identical to A on every input above (no hooks on any
  staged-create target — this file).
- All: the R29 flip (inputs 3-5) governs what observation style
  any hook proof test may use; no input recommends an alternative.

### JEV-PENDING markers added by this section

- (i) R29 flip: input-alias observations allowed or forbidden.
- (ii) Committed-handler execution inside example observation
  scope (decides input 1 under B).
- (iii) `count=...`-starts-at-0 seed-closure reading
  **UNVERIFIED** by execution (derived from seed lists +
  DESIGN:435).
- (iv) Resume-example (CanCheck:60-64) executability
  **UNVERIFIED** (R27 ordinary-path rejection site; needs a
  checker re-run).
- (v) Every discrimination map is draft-text derivation, not
  observed execution (T23a-scope work).

### Commands run (read-only)

1. `T23`/`T18` searches in plan + tasks.md + evidence (refs above).
2. `emitted-example contract` search (4 hits: tasks.md:213/:215,
   app-intent.md:352, root-causes.md:575).
3. Full read of execution-contract.md §3/§5/§9
   (frozen rules + T04b remainder).
4. Direct reads: root-causes.md:562-579 (R29), tasks.md:198-217
   (T21/T22/T23), CanMaintain:68-137, CanFeedback:37-82,
   CanOnboard:22-61, CanShift:78-106, CanDiscover:240-280,
   CanLeave:66-95 + :124-144, CanCheck:36-64 + :82-100 + :122-155,
   CanMember:225-257, DESIGN.md:125-135 + hook-clause search.
5. `examples create|update|delete` corpus census (26 blocks) +
   `examples` vs `scenario` line censuses over the 16 hook files
   (zero hook-attached examples) + crud-decl census (CanCheck has
   none; shared files have zero examples lines).
6. T23-owned file existence check (`ls`): testkit runner
   (`loader.ts`, `table.ts`), `contracts/src/examples.ts`,
   `compiler/src/analysis/examples.rs`,
   `compiler/src/codegen/bdd.rs` all exist as files — but T21/T22/T23
   evidence is pending, so existence proves scaffolding only, not
   executed behavior.

### Handoff

- Writer: L3 T31a-item5. This section appended only; prior
  alternatives/fairness/checklist/enumeration/records/item-3
  section untouched (checklist item-5 marker left for the
  coordinator per the append-only reservation).
  DESIGN.md/GRAMMAR.md/DECISIONS.md, drafts, code, tools/jev.py,
  tasks.md/monitor.md/inbox untouched (read or coordinator-owned);
  no JEV run; no Git.
- Release: this file is RELEASED to the coordinator for gate scheduling.
