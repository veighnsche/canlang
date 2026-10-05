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

1. T30 completion: provenance-correct hook payload typing (C6 `{opaque}`
   cluster resolved) so the gate judges secondary-write rules, not payload
   opacity.
2. Full enumeration of hook bodies with secondary writes across all 52
   sources (only CanCheck `initial`/`configured` sampled here) with
   per-site effect classification (parented child / timer / cross-row /
   delete attempt).
3. R27 input from T18: the adopted default/server/update/hook rule for
   server-owned fields — every alternative inherits its **JEV-PENDING**.
4. T28/T29 ownership input where staged writes touch imported references
   (T31 depends on applicable T28/T29; T28 alone is insufficient).
5. T23 example-contract input (R29): whether hook-behavior examples may
   observe through input bindings or must reload stored state.
6. Durable-transaction evidence plan: per T31 acceptance, memory evidence
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
