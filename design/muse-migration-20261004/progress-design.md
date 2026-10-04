# C1 — complete population processing

Design handoff, 2026-10-04. **Candidate for coordinator review; BLOCKED for routine application.** This file changes no accepted language contract, app, target or requirement. The shared mechanism below is unimplemented. The Can and JavaScript sections are changed-section witnesses, not compiler output or executed tests.

The immediate result is a bounded candidate that covers Shift eligibility reconciliation and Volunteer cancellation/reminder refresh without a business maximum of 500. Volunteer material rescheduling and venue invalidation have an additional historical-recipient/consent problem; they are explicitly not solved by replacing their loops with this mechanism.

## Evidence and decision boundary

Read [the current workload split](../../draft/MIGRATION.md), [the earlier investigation](../owner-fanout-20261004.md), [the saved consultation](../jev/owner-fanout-20261004/review.md), [DESIGN §§2–7 and §13](../../DESIGN.md), and the current [Shift source](../../draft/CanShift.can), [target](../../draft/CanShift.mjs), [requirements](../../draft/CanShift.md), [Volunteer source](../../draft/CanVolunteer.can), [target](../../draft/CanVolunteer.mjs) and [requirements](../../draft/CanVolunteer.md). Employee identity/current membership was checked against [Employees.can](../../draft/shared/Employees.can).

Verified constraints:

- `for ... limit=N` rejects the entire mutation on excess. A larger N, offset pagination, repeated first-N queries or sorting opaque IDs cannot establish complete progress.
- `on=Model.update` and `.create` are synchronous hooks. Committed `.updated`/`.created` sources are later independent occurrences carrying identity, not historical record snapshots.
- Existing rows expose their admitted version throughout one transaction; writes reserve exactly `v+1`. The update hook's after-version is already `v+1`. New child transactions must recalculate versions from their own admitted state.
- Both apps currently use one team D1 authority. D1's database revision fence must include scan/admission metadata as well as business and authorization reads/writes. This exercise cannot use an eventual DO directory as proof of population coverage.
- Shift's five owner-wide handlers have two independent populations, Commitment and Swap. Availability hooks currently put both loops inside the availability write itself. Volunteer has direct user-operation loops, a reminder hook and a nested venue-event loop; these are not all equivalent to asynchronous notification delivery.
- Current admission and dispatch predicates remain essential while reconciliation is pending. A conflict flag is retained evidence, not permission to release a reservation or automatically restore work.

The required three-call JEV round is incomplete: completed requests 1 and 3 chose shared enumeration with probabilities 0.78 and 0.88; [request 2](../jev/owner-fanout-20261004/2.request.json) has no provider response. [The rejection record](../jev/owner-fanout-20261004/2.blocked.json) says automatic approval review required specific authorization for that exact nonpublic payload. No request was sent or rephrased during this handoff. Two advisory outcomes do not adopt syntax or establish correctness.

The earlier alternatives remain fairly distinguishable: authored continuation can use the same indexed cohort machinery but repeats app state; periodic review can use the same complete initialization machinery but adds unchanged recurring work and detection lag; shared enumeration centralizes that repeated lifecycle while adding a language/runtime contract. None has implementation or performance evidence. This handoff supplies a shared-enumeration witness for review; it does not resolve the blocked consultation by declaring another alternative settled.

## One minimal candidate contract

Add one optional trusted-handler suffix, illustrated as:

```can
scenario review on=Source each=Model as item
 do
  if current_app_predicate(item,event)
   ...
```

The only additional source form is `each=domain as binding`. `domain` is one stored model at the already resolved owner, or one immutable parent-child collection reached from an event record reference, such as `event.opportunity.Signup`. It is not an array, external provider page, DO-directory traversal, arbitrary query, `select`, `order`, `limit`, nested enumeration or a user-callable operation. Selection stays in ordinary `if`/`require` and `do`; there is no second authored selector language. `each` is forbidden on CRUD hooks, `by=`, and read scenarios. Adapters can commit an ordinary domain event from a hook when later processing is intended.

One source occurrence admits one run per canonical declaration and concrete owner. Admission captures an immutable, protected per-model insertion-sequence high-water mark H and, for a child collection, the fixed parent identity. This sequence is runtime metadata, not `id`, `created`, a user-authored field or a public query cursor. Record insertion and ordinal allocation share the owner transaction. Ordinary edits do not move a row, containment is already immutable, and new records cannot reuse an old ordinal. Restores follow the existing stop/fence/replay rules.

The covered population is **every record identity in that model/parent prefix at admission**, up to H. It is not the records that satisfied a mutable predicate at source-event time. Scan the complete prefix in bounded indexed steps. Do not advance a cursor over only currently matching rows: matching status can change while processing. Safe pruning may use only the fixed owner/model/immutable parent boundary. A missing, archived or expired row has an explicit skipped outcome and contributes no expired content. The protected traversal catalog must retain safe identity/ordinal/immutable-parent tombstones for removals that active runs still need to account for; ordinary content retention does not permit resurrecting removed fields. This catalog is part of the proposed shared facility, not an assumption about an existing index. Scanning protected insertion positions must still reach the end when records disappear; deleted ordinal gaps are not failures or restart points.

Each scanned available identity has a stable child key derived from `(compatible declaration contract, owner, source occurrence, record identity)`. The batch that advances the scan checkpoint also durably admits its children and the next scan step, or commits neither. A recovery scan finds unfinished work without a live callback. Pagination is an implementation work budget: 499, 500, 501 and 1,000 records all belong to the same complete contract. Backpressure may pause admissions; it may not discard the unvisited suffix or mark it complete.

Each child is one ordinary owner transaction. It resolves the record afresh, establishes current verified source authority, uses its own admitted `now`, and rereads all mutable dependencies under the existing fence. The source payload retains explicitly captured facts; source reference fields do not become historical snapshots. A false body `if` commits a no-effect success. A false authored `require` remains a terminal failed child with no business effects. A missing/expired record is skipped before the body. Runtime transient failures retry that same child identity and fixed admitted facts using the existing retry rules. A failed child does not stop scanning or another child's execution.

Duplicate source delivery reuses the original run, H, checkpoint and child keys. It cannot recapture a larger cohort. Duplicate child delivery replays its receipt rather than rerunning the body. A crash before admission/checkpoint commit leaves neither; a crash after it leaves both. Business writes, the child's receipt and its outbox commit atomically. External delivery retains its own existing uncertain/succeeded/failed contract; enumeration completion never claims an email was delivered.

No ordering or atomicity exists between children, including two declarations responding to the same event. Their predicates must be correct in either order. Later source occurrences create distinct current-state review runs; old children cannot overwrite newer decisions merely because their source event was older. Already committed effects are not undone by supersession. Pin queued work to its compatible declaration contract under DESIGN §11.3; upgrades cannot silently reroute it to changed handler semantics.

Current-state completeness means each identity in the finite admitted cohort receives one outcome using state at its child checkpoint. A mutation after that checkpoint must have its own valid admission checks and, where needed, a later declared review source. Rows inserted after H use their creation checks and later sources. Enumeration does not infer missing change notifications, prove that every row was eligible at one common instant, or guarantee historical transition delivery. This is the precise limit of the guarantee, not silent truncation.

Expose durable run progress to existing authorized runtime operators: scanning/draining, succeeded, skipped and failed child counts, unfinished cursor, retry state, and safe per-child failure attribution. A fully scanned run with failed children is `attention`, never successful completion. A terminal failed receipt remains terminal on replay. Any shared recovery control would need explicit failed-only re-admission with retained verified payload/provenance, a new stable recovery identity, and an audit link to the failed child; it must refuse succeeded or unresolved/uncertain children. That recovery control is a **proposed obligation of this candidate**, not an existing API. Existing authored per-record business recovery remains available with its own user authority. Retention must preserve run/child replay identities for the whole work horizon without retaining expired business payloads; expired required content yields an explicit unavailable/skipped outcome.

One child can still exceed its own aggregate/query/effect budget and fail. This contract solves population enumeration, not unbounded single-record business computation, multi-owner work or arbitrary bulk atomicity. Progress assumes available storage, fair dispatch and finite individual work; permanent failures remain visible for resolution.

### Desired JavaScript shape

There is one corresponding metadata form, and no app-authored cursor model or runner:

```js
const proposedMetadata = { handlers: {
  "owner.review": {
    on: Source,
    each: { model: "owner.Model", bind: "item" },
    handler: "review",
  },
  "owner.review_child": {
    on: ChildSource,
    each: {
      model: "owner.Child",
      parent: (c, { event }) => event.parent,
      bind: "item",
    },
    handler: "review_child",
  },
} };
// Registry body runs once per admitted record, with ordinary proposed effects.
async function review(c, { event, item }) { /* source do body */ }
```

`parent` resolves the immutable admitted collection identity once; it is not a mutable row filter. `bind` determines the additional typed body input. H, child keys and cursor state are generated runtime work metadata, absent from business parameters and public tool schemas. These are desired interface shapes, not claims that `@canlang/stdlib` implements enumeration.

## Shift changed-section witness

The five source adapters remain small and preserve their actual source authority. Availability uses its existing hook to emit a later review, so a valid availability edit no longer attempts a 500-row reconciliation in its own transaction. The event carries identities; all eligibility is current when a child executes.

```can
## Add in shift Given. Nullable event fields default null under ordinary field rules.
event EligibilityReview { employee:Employee?, location:text?, account:user?, roster:Roster? }

## Replace the five existing population bodies in shift When.
scenario employee_changed on=EmployeeChanged
 do emit EligibilityReview {employee=event.employee}
scenario location_changed on=Location.updated
 do emit EligibilityReview {location=event.id}
scenario member_removed on=teams.member_removed
 do emit EligibilityReview {account=event.user}
scenario availability_changed on=Availability.update
 do emit EligibilityReview {employee=event.after.employee,roster=event.after.parent}
scenario availability_created on=Availability.create
 do emit EligibilityReview {employee=event.after.employee,roster=event.after.parent}

scenario review_commitment on=EligibilityReview each=Commitment as commitment
 do
  if commitment.active and commitment.until+commitment.after>now and (event.employee==null or commitment.employee==event.employee) and (event.location==null or commitment.location.id==event.location) and (event.account==null or commitment.employee.user==event.account) and (event.roster==null or commitment.parent==event.roster)
   if not eligible(commitment) or any(commitment.Duty as duty,duty.role!=commitment.employee.role)
    set commitment {conflict=true}
    emit ReservationOutcome {value={source=commitment.source,revision=commitment.revision,state=unavailable,reference=commitment.id}}

scenario review_swap on=EligibilityReview each=Swap as swap
 do
  let commitment=swap.parent.parent
  if swap.state==open and commitment.until>now and (event.employee==null or swap.original==event.employee or swap.substitute==event.employee) and (event.location==null or commitment.location.id==event.location) and (event.account==null or swap.original.user==event.account or swap.substitute.user==event.account) and (event.roster==null or commitment.parent==event.roster)
   if not swap.parent.published or commitment.conflict or not eligible(commitment) or swap.original!=commitment.employee or commitment.version!=swap.revision or not can_work(swap.original.user,commitment.location) or not can_work(swap.substitute.user,commitment.location) or swap.original.role!=swap.parent.role or swap.substitute.role!=swap.parent.role or not (commitment.skill in swap.substitute.skills) or not fits(commitment.parent,swap.substitute,commitment.from,commitment.until,commitment.before,commitment.after,commitment) or not travel_entered(commitment.parent,swap.substitute,commitment.location,commitment.from,commitment.until,commitment.before,commitment.after,commitment)
    set swap {state=obsolete}
```

The swap body reads actual commitment eligibility itself; it does not depend on the commitment child having first set `conflict`. It preserves accepted/rejected/history rows, and current role/membership restoration before evaluation is not mistaken for a still-current revocation. A previously committed conflict or obsolete decision remains sticky. The source's `event.active`/`event.revision` are not current authority and are deliberately not copied over newer records. The current business `commitment.revision` in an emitted outcome is separate from the runtime row version.

Desired target changed sections, using the existing scalar, identity, query and effect conventions:

```js
// Add this entry to appDefinition.events.
const proposedShiftEvents = {
  "shift.EligibilityReview": { fields: {
    employee: { type: Employee, nullable: true },
    location: { type: "text", nullable: true },
    account: { type: "user", nullable: true },
    roster: { type: "shift.Roster", nullable: true },
  } },
};
// Keep the five existing source metadata entries; replace their bodies below.
// Add these two entries to appDefinition.handlers:
const proposedShiftHandlers = {
  "shift.review_commitment": {
    on: "shift.EligibilityReview",
    each: { model: "shift.Commitment", bind: "commitment" },
    handler: "review_commitment",
  },
  "shift.review_swap": {
    on: "shift.EligibilityReview",
    each: { model: "shift.Swap", bind: "swap" },
    handler: "review_swap",
  },
};

const proposedShiftBodies = {
  async employee_changed(c, { event }) {
    await emit(c, "shift.EligibilityReview", { employee: event.employee });
  },
  async location_changed(c, { event }) {
    await emit(c, "shift.EligibilityReview", { location: event.id });
  },
  async member_removed(c, { event }) {
    await emit(c, "shift.EligibilityReview", { account: event.user });
  },
  async availability_changed(c, { event }) {
    await emit(c, "shift.EligibilityReview", {
      employee: event.after.employee, roster: event.after.parent,
    });
  },
  async availability_created(c, { event }) {
    await emit(c, "shift.EligibilityReview", {
      employee: event.after.employee, roster: event.after.parent,
    });
  },
  async review_commitment(c, { event, commitment }) {
    if (commitment.active &&
        compareInstant(addDuration(commitment.until, commitment.after), c.now) > 0 &&
        (event.employee === null || same(commitment.employee, event.employee)) &&
        (event.location === null || commitment.location.id === event.location) &&
        (event.account === null || same(commitment.employee.user, event.account)) &&
        (event.roster === null || same(commitment.parent, event.roster))) {
      if (!(await eligible(c, commitment)) ||
          await any(records(c, "shift.Duty", { parent: commitment }),
            duty => duty.role !== commitment.employee.role)) {
        await set(c, commitment, { conflict: true });
        await emit(c, ReservationOutcome, { value: {
          source: commitment.source, revision: commitment.revision,
          state: "unavailable", reference: commitment.id,
        } });
      }
    }
  },
  async review_swap(c, { event, swap }) {
    const commitment = swap.parent.parent;
    if (swap.state === "open" && compareInstant(commitment.until, c.now) > 0 &&
        (event.employee === null || same(swap.original, event.employee) || same(swap.substitute, event.employee)) &&
        (event.location === null || commitment.location.id === event.location) &&
        (event.account === null || same(swap.original.user, event.account) || same(swap.substitute.user, event.account)) &&
        (event.roster === null || same(commitment.parent, event.roster))) {
      if (!swap.parent.published || commitment.conflict || !(await eligible(c, commitment)) ||
          !same(swap.original, commitment.employee) || commitment.version !== swap.revision ||
          !(await can_work(c, swap.original.user, commitment.location)) ||
          !(await can_work(c, swap.substitute.user, commitment.location)) ||
          swap.original.role !== swap.parent.role || swap.substitute.role !== swap.parent.role ||
          !swap.substitute.skills.includes(commitment.skill) ||
          !(await fits(c, commitment.parent, swap.substitute, commitment.from, commitment.until,
            commitment.before, commitment.after, commitment)) ||
          !(await travel_entered(c, commitment.parent, swap.substitute, commitment.location,
            commitment.from, commitment.until, commitment.before, commitment.after, commitment))) {
        await set(c, swap, { state: "obsolete" });
      }
    }
  },
};
```

The names `proposedShiftHandlers`/`proposedShiftBodies` only delimit this document's snippets; the actual target would merge their entries into its existing metadata/registry. They are not new app APIs. Nullable omitted event fields must be normalized to null by their declared schema before body invocation, as in the Can witness.

The existing atomic 100-swap loops in accept/cancel/reconcile/recover_commitment and 100-conflict absence processing are outside this conversion. Their all-or-reject semantics continue to be honest bounds; this witness does not silently make multi-record atomic business decisions partial. `recover_commitment` is still a concrete selected-record recovery path, with its documented local limit. Consumers Book/Field/Hire/Leave and ScheduleV1 signatures do not change.

## Volunteer changed-section witness: cancellation and reminder refresh

Cancellation is persistent parent truth: once `opportunity.cancelled=true`, no subsequent operation can reopen it. This permits current-state enumeration without an event-time participant snapshot, provided all ways of treating an unprocessed signup as usable read that parent truth immediately.

```can
## Add in volunteer Given; retain Signup.state as stored history.
event OpportunityCancelled { opportunity:Opportunity, reason:text }
derive Signup.reserves_place:bool = row.state in [registered,confirmed] and not row.parent.cancelled
derive Signup.cancelled:bool = row.state==cancelled or (row.parent.cancelled and row.state in [registered,confirmed])

## Replace cancellation. The reason is a captured event value, not a later editable field.
# Cancel the activity immediately and retain every signup and task.
scenario cancel(opportunity:Opportunity,reason:text) by=organizer
 require can_work(actor,opportunity.location) and not opportunity.cancelled and trim(reason)!=""
 do
  set opportunity {cancelled=true,open=false}
  emit OpportunityCancelled {opportunity,reason}

scenario cancel_signup on=OpportunityCancelled each=event.opportunity.Signup as signup
 do
  if signup.parent.cancelled and signup.state in [registered,confirmed]
   set signup {state=cancelled}
   cancel signup.id
   let signup_revision=signup.version+1
   send Mail.send {to=signup.email,subject=format("Volunteer activity cancelled"@{nl="Vrijwilligersactiviteit geannuleerd"},locale=null),body=event.reason} when=signup.version==signup_revision and signup.state==cancelled and signup.parent.cancelled as notice
   set signup {notification=notice}

## Replace opportunity_changed's synchronous reminder loop with a committed handler.
scenario refresh_reminders on=Opportunity.updated each=Signup as signup
 do
  if signup.parent.id==event.id
   cancel signup.id
   if signup.state==confirmed and not signup.needs_confirmation and not signup.parent.cancelled and (signup.parent.venue==null or signup.parent.venue_confirmed) and signup.parent.from>now+1d
    schedule signup.id at=signup.parent.from-1d event=Reminder {signup,revision=signup.version,opportunity_revision=signup.parent.version}
```

The refresh body uses the current parent version, not `event.version`, and does not write the signup. Remove only the identical reminder loops from `publish` and `link_venue`; their existing leading guards and single parent `set` remain. Those writes already create `Opportunity.updated`. Creation/confirmation's record-addressed reminder scheduling stays. Cancellation and refresh children are correct in either order because neither can arm a reminder for a cancelled parent.

The cancellation witness is incomplete unless these exact companion changes are applied together:

1. Replace active reservation tests with `signup.reserves_place` in Opportunity.remaining, the capacity invariant, public availability, signup/reactivate/reconfirm conflict queries (including `other`), link_venue's active-signup guard and reschedule's active-signup conflict guard. This releases reservations immediately at parent cancellation rather than waiting for each stored state update. Count/aggregate resource limits still apply and must fail honestly; this is not a performance proof for unbounded conflict computation.
2. Add `not signup.cancelled` to withdraw's guard. Before its child runs, a cancelled signup must not become withdrawn and evade the cancellation notice. `confirm`, `reactivate`, `reconfirm`, `complete`, `attendance`, `work` and `work_detail` already check parent cancellation; retain those checks. Task CRUD additionally requires `row.parent.reserves_place`, preventing task edits/creation during the pending cancellation pass.
3. Add the derived `cancelled` field to both explicit Signup read-grant field lists. In both participant lists, render the existing localized Cancelled caption when `row.cancelled`; otherwise show `row.state`. Retain attendance/withdrawal history and receipt status. Do not show a still-stored confirmed state as current confirmation after parent cancellation, and do not grant the parent record or email payload merely to render the derived bit.
4. Keep every Reminder admission and dispatch parent-cancellation check. Parent version guards suppress already scheduled pre-change reminders immediately; cancellation of each pending schedule is eventual cleanup. A provider-claimed notice before cancellation retains the ordinary external-effects boundary.
5. Parent cancellation success means the activity is cancelled and its durable enumeration trigger has committed, not that every child is already admitted or that all children/providers succeeded. Operator progress must expose remaining/failed children. No failed child can make the parent usable again.

Desired target changed sections:

```js
const proposedVolunteerEvents = {
  "volunteer.OpportunityCancelled": { fields: {
    opportunity: { type: "volunteer.Opportunity" },
    reason: { type: "text" },
  } },
};

const proposedVolunteerHandlers = {
  "volunteer.cancel_signup": {
    on: "volunteer.OpportunityCancelled",
    each: {
      model: "volunteer.Signup",
      parent: (c, { event }) => event.opportunity,
      bind: "signup",
    },
    handler: "cancel_signup",
  },
  "volunteer.refresh_reminders": {
    on: "volunteer.Opportunity.updated",
    each: { model: "volunteer.Signup", bind: "signup" },
    handler: "refresh_reminders",
  },
};

// Existing derived-field metadata resolves these registry entries.
const proposedVolunteerDerives = {
  "Signup.reserves_place": (c, row) =>
    ["registered", "confirmed"].includes(row.state) && !row.parent.cancelled,
  "Signup.cancelled": (c, row) => row.state === "cancelled" ||
    (row.parent.cancelled && ["registered", "confirmed"].includes(row.state)),
};

const proposedVolunteerBodies = {
  async cancel(c, { opportunity, reason }) {
    check(hasRole(c, "volunteer.organizer"), "forbidden");
    check(await can_work(c, c.actor, opportunity.location) &&
      !opportunity.cancelled && reason.trim() !== "");
    await set(c, opportunity, { cancelled: true, open: false });
    await emit(c, "volunteer.OpportunityCancelled", { opportunity, reason });
  },
  async cancel_signup(c, { event, signup }) {
    if (signup.parent.cancelled && ["registered", "confirmed"].includes(signup.state)) {
      await set(c, signup, { state: "cancelled" });
      await cancel(c, signup.id);
      const signup_revision = int64(signup.version + 1n);
      const notice = await send(c, "volunteer.Mail.send", {
        to: signup.email,
        subject: format(c, message("Volunteer activity cancelled", {
          nl: "Vrijwilligersactiviteit geannuleerd",
        }), { locale: null }),
        body: event.reason,
      }, { when: async c => signup.version === signup_revision &&
        signup.state === "cancelled" && signup.parent.cancelled });
      await set(c, signup, { notification: notice });
    }
  },
  async refresh_reminders(c, { event, signup }) {
    if (signup.parent.id === event.id) {
      await cancel(c, signup.id);
      if (signup.state === "confirmed" && !signup.needs_confirmation &&
          !signup.parent.cancelled &&
          (signup.parent.venue === null || signup.parent.venue_confirmed) &&
          compareInstant(signup.parent.from, addDuration(c.now, 86400000n)) > 0) {
        await schedule(c, signup.id, subtractDuration(signup.parent.from, 86400000n),
          "volunteer.Reminder", { signup, revision: signup.version,
            opportunity_revision: signup.parent.version });
      }
    }
  },
};
```

As in the existing target, dispatch callbacks retain lexical record locators and reload their current state under the shared dispatch contract; capturing a JS object does not freeze its old fields. Add `emit` to the target's standard imports and the event/derived schemas to its existing metadata. The companion query/guard/UI edits above lower through existing `records`, `count`, `any`, typed read-grant arrays and presentation `if` conventions; they do not add a helper API. Both writes to the cancellation signup reserve one version increment, so the dispatch guard correctly uses admitted `signup.version+1`.

## Volunteer material changes remain a separate blocking decision

`reschedule` currently checks the complete active participant conflict set, writes the new interval, then in the same transaction resets every active signup to registered/needs_confirmation and notices those whose old state was confirmed. `venue_changed` closes every affected opportunity, does the same reset and selects the same historical recipient category. All those writes roll back together on a loop excess. Neither source provides a captured per-signup historical state.

The current-state cohort contract alone cannot reproduce that behavior:

- If the parent changes first but the signup child is delayed, existing `confirm`, `complete`, attendance and work projections can treat an old confirmation as current unless they gain a current material-revision/consent fence.
- If a volunteer accepts the new interval before the delayed child, blindly setting needs_confirmation again destroys newer consent. If the worker skips that row instead, it can lose the fact that the volunteer was confirmed when the change occurred and owed a change notice.
- A second reschedule, withdrawal/reactivation or venue recovery can change the recipient classification before an earlier child reads it. Frozen reason text alone does not freeze historical membership. Two enumeration handlers, an insertion cutoff or a larger cap do not fix this.
- Closing opportunities and marking signups in one unordered source fanout is unsafe: a signup child can run before its opportunity is closed. A causal owner event emitted by each successfully closed opportunity supplies ordering, but still does not establish event-time recipient state or immediate consent invalidation.
- The `all`/`any` participant-conflict check is still one atomic business decision. Chunking that read while allowing concurrent admissions can accept an invalid move unless the contract supplies a validating fence or explicit business pending phase.

The smallest next design question is therefore: **for a material change, must notice eligibility preserve the exact previously confirmed participant set, or may it use explicitly defined current-recipient semantics after immediate consent invalidation?** The requirements and existing source support the former more strongly; silently weakening it is not a routine migration.

If historical recipients are retained, the next witness needs a bounded source-checkpoint membership/capture facility or an explicit parent transition phase that prevents classification changes until their evidence is captured, with its own failure/recovery and authority rules. If current-recipient semantics are deliberately accepted instead, the next witness still needs parent material generations, per-signup accepted/confirmed generations, guards on every consumer, and explicit stale-child/supersession behavior. Both directions change business meaning or language obligations and need a concrete fair comparison; neither is smuggled into `each` here. Automatic audit history is not an invented event-time query API. No new JEV request is authorized by the existence of this paragraph while the exact-payload block is unresolved.

## Boundary and failure BDD

These are independently stated expected outcomes. Existing inline tables can express individual child business cases after handler-fixture binding is specified; cohort sizes, crashes, fresh reads, interleavings and dispatcher fairness need shared-runtime fixtures. Do not author fake `each` example selectors or claim the existing parser/BDD runner executes them.

| Given / When | Expected Then |
| --- | --- |
| An admitted Shift review has 499, 500, 501 or 1,000 eligible model identities; all bodies fit their own bound | Every identity receives one terminal outcome after available retries; crossing 500 alone causes no failure or omission. Invalid commitments remain allocated and report unavailable. |
| The cohort is empty | Scan completes with zero children; it does not wait for a future insertion or report failure. |
| Source delivery repeats before/after partial processing | Same H and child identities; no second conflict write, cancellation intent or notification for an already successful child. |
| Crash immediately before admission/checkpoint batch commit | Neither checkpoint nor its children commits; resumed scan safely repeats that batch. |
| Crash immediately after commit, before queue publication | Committed children/successor are found by durable recovery; no visited suffix is lost. |
| Child crashes before business commit; or commits and loses its reply | First case retries without partial writes; second replays its saved receipt/outbox without a second effect. |
| One child fails a business require or exceeds its local work bound | Its provisional writes/outbox roll back; later identities still run; overall run reports attention with that failure. Receipt replay does not silently re-evaluate it. |
| A record is inserted after H | This run does not expand or chase it forever. Its creation passes current admission; any required follow-up has its own declared source. |
| A pre-H record is initially unrelated and becomes related before its child | Full-prefix enumeration still admits it; fresh body selection sees the new relationship. A mutation after its child needs its own review source. |
| A pre-H row disappears or expires before scan/child | Explicit skip, no resurrected content or restart from zero; later ordinals still complete. |
| Membership is removed, then restored before a Shift child | Current can_work/eligible decides. The removal envelope alone cannot invalidate currently eligible work. Earlier committed conflict/obsolete evidence is not automatically cleared. |
| Swap child runs before commitment child for a newly ineligible employee | Swap independently rejects current eligibility and becomes obsolete; outcome is not dependent on child ordering. |
| Availability edit affects 501 commitments | The authorized edit plus review event commits without a fanout loop; current eligibility denies invalid new work immediately; all cohort commitments are eventually reviewed. |
| 1,000 active Volunteer signups, then organizer cancels | Parent is cancelled immediately; every signup is effectively cancelled and reserves no place before child processing. Tasks/reminders cannot become usable during lag. Eventually every eligible child stores cancelled and one guarded notice intent. |
| A confirmed signup's cancellation child fails while other children succeed | Parent and derived cancellation still deny work for the failed signup; other notices survive; failed child remains visible. Do not report all notices queued/sent. |
| Volunteer attempts withdraw/confirm/reactivate/complete/attendance after parent cancellation but before their child | Each rejects; no operation can transform an active cancelled signup into a state that escapes the intended cancellation handling. Attended/no_show/previously withdrawn historical signups stay historical and receive no new cancellation notice. |
| Another opportunity checks overlap immediately after this parent cancels | Cancelled signups no longer reserve time, even when their stored state is still registered/confirmed. |
| Old Reminder is due after cancellation or a parent version change | Admission/dispatch current guards prevent a stale send. A provider claim that already preceded the change retains ordinary uncertain/accepted semantics. |
| Delayed Opportunity.updated handler follows a later parent write or newer confirmed signup | It uses current parent/signup versions and current eligibility, replacing the keyed pending reminder for current state. It cannot rearm cancellation or overwrite a signup state. |
| A material reschedule is implemented by only replacing its loop with each | **Reject that application**: old confirmation can remain usable, newer consent can be overwritten, and previously confirmed recipients can be lost. This negative case is why material change remains blocked. |
| Same record belongs to another team or a DO owner discovered only through an eventual directory | Never admitted by this run; cross-owner traversal is unsupported and cannot be reported complete. |
| Release changes an each handler while work is pending | Existing declaration-contract compatibility/disposition rules apply; a name match cannot retarget work or erase failures. |

## Exact handoff and disposition

| File / area | Proposed application after coordinator adoption | Status |
| --- | --- | --- |
| `DESIGN.md` §§6, 7, 13 | Add only the trusted per-record handler contract, finite cohort/progress/recovery semantics and desired metadata above; keep ordinary for-limit atomicity | BLOCKED: incomplete JEV round and coordinator decision |
| `GRAMMAR.md` scenario closed attributes/production | One restricted `each=domain as binding` suffix and rejection cases; no broad query-tail or loop reinterpretation | BLOCKED with contract |
| `draft/CanShift.can` | Add EligibilityReview; replace five population bodies; add commitment/swap handlers and business examples | Candidate witness ready for semantic review; R5 blocked until adoption |
| `draft/CanShift.mjs` | Matching event schema, handler metadata, registry bodies and translated existing/added examples | Same |
| `draft/CanShift.md` | Replace current rejecting-500 automatic-progress limitation with the actual finite-cohort/current-state/failed-child guarantee; retain local 100-bound limits | Same |
| `draft/CanVolunteer.can` | Cancellation event/child; effective reservation/cancelled derives and exact guards/grants/UI above; committed reminder refresh; remove publish/link reminder loops | Candidate subset ready for semantic review; R5 blocked until adoption |
| `draft/CanVolunteer.mjs` | Matching schemas, metadata, callbacks, guard/query/UI changes and examples | Same |
| `draft/CanVolunteer.md` | State immediate parent cancellation/effective release versus eventual stored signup/notice progress; define current reminder refresh; disclose retained limits | Same |
| Volunteer `reschedule` and `venue_changed`, their examples and targets | Exact historical-recipient/current-consent/atomic-conflict outcome requires its own complete witness | BLOCKED: additional business/design decision above |
| Shift's per-duty 100-swap transactions, reservation ingress, consumers and shared Employees | No conversion implied by this cohort witness | Existing accepted semantics retained; their limits remain explicit |

No other files are owned by this handoff. Root owns acceptance, shared DESIGN/GRAMMAR edits and publication to Muse. Muse must not apply the illustrated spelling merely because it appears here. In particular, do not turn `limit=500` into a capacity rule, catch-and-ignore a limit rejection, delete cap failures from examples, or mark the C1 population gap complete after migrating only notifications.

Verification performed: current source/desired-target/requirements were read against the owner, hook, version, query, replay and delivery rules; both application witnesses were manually checked for source/target evaluation order and retained version meaning. All three JavaScript code fences pass `node --check` as standalone temporary snippets. That check validates syntax only, not identifier linking, runtime helpers or the proposed each metadata. No Can parser, compiler, runtime, BDD runner, provider delivery or concurrency execution is claimed. A bounded independent child review was attempted but the dispatcher reported its thread limit; that review did not occur.

**READY:** verified gap, minimal candidate cohort contract, source/JS changed-section witnesses for Shift and safe Volunteer subset, explicit BDD and file ownership. **BLOCKED:** adoption/routine application while the exact second JEV payload remains unapproved; complete Volunteer material-change migration until historical recipients, immediate consent and the atomic conflict decision are specified together. The existing accepted rules justify the diagnosis and ordinary body guards, but do not already authorize new traversal semantics.
