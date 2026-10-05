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
4. T28/T29 ownership input where staged writes touch imported references
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
