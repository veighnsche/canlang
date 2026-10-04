# A04 handoff — Rent retained-history application (explicit per-entity facts)

User-authorized 2026-10-04 (coordinator-authored; no prior A04 history design existed).
Codex review pending. Design only; no app file has been changed by this handoff.

Status: **COORDINATOR DESIGN for A04 implementation.** Baseline: current
`draft/CanRent.can` (1466 lines, 52 `create ResourcePolicy` sites),
`draft/CanRent.mjs`, `draft/CanRent.md`, DESIGN §§2, 4, 5.1, 7, 9, 13,
`draft/MIGRATION.md` task 15 / lane C2, and
`design/rent-history-growth-20261004.md` with its evidence folder. This handoff
owns no shared-language change and no compiler/stdlib/infrastructure design.

## 1. Investigation: current retained-history behavior

What history Rent retains today, where it lives, and under what authority:

| # | What is retained | Where | Authority / policy |
| --- | --- | --- | --- |
| H1 | Full resource snapshots: scalar `active/capacity/pooled/timezone` plus **every** Window, Downtime, Booking and Venue value (`CanRent.can:175-180`) | Locked `ResourcePolicy in Resource` rows, one per capture; `resource_evidence` derive (`:183`); read by `resource_report` (`:294`) and `saved_rows` (`:174`) | `policy ResourcePolicy read=reservation_manager and can_work(actor,row.parent.location)` (`:181`); report is `read=true scope=authority by=reservation_manager` + `can_work` (`:294-295`); no retention declared (indefinite) |
| H2 | Original vendor booking assertions: source namespace, exact external key, nullable original facts, source file, attestation; plus reviewed current Customer/Resource/account mappings | Locked `LegacyBooking` rows (`:101-108`); `retain_legacy` / `legacy_matches` / `link_legacy` (`:231-265`); `/workspace/history` page (`:1305-1318`) | Staff: `(reservation_manager or finance) and can_work` (full); mapped account: restricted `source,external_id,location,facts,customer,resource` fields only (`:106-107`); never enters ResourcePolicy, reports, live Booking, or money/allowance state |
| H3 | Frozen commercial evidence: Booking rate/tax/total/terms/source/buffers/benefit inputs/quote locks (`:218-219`), `ReservationFence` locked accepted offer (`:90-92`), `MovementCredit`, per-Booking `CommercialSale` phase/revision | Locked fields and fenced child rows on live records | Existing Booking/CommercialSale/Movement policies; D09 Notice delivery association observes the retained Mail receipt (untouched by this design) |
| H4 | Automatic row audit surfaced through UI `history` widgets (catalog, reservations, bookings, arrivals, refund-review pages) | Runtime audit, not a typed Can read API | DESIGN §9: requires current record access, projected through current readable-field grants; 90-day default horizon (DESIGN §7); longer business evidence must be actual retained records |

Capture timing today: 6 CRUD-hook captures (Resource/Window/DayCalendar
create+update, `:269-292`) plus 46 explicit scenario captures after committed
relevant state (holds, moves, occupancy, downtime, venues, quotes,
settlement branches). Two same-admission coalescings are already committed
(`movement_result` 3→1 at `:515`; quote acceptance 2→1): only final committed
state is promised, never intermediate same-clock statements (MIGRATION.md).
Verified 2026-10-04: no `on=ResourcePolicy` handler, no `policy_snapshot_*`
consumer, and no internal `call resource_report` exists in any draft source;
`resource_report` is invoked only through its registry/page form. J05 verified
the 4 CRUD declarations and disabled identities; D09's Notice association is
out of scope here.

Gaps versus a complete retained-history application:

- G1 (growth): every capture recopies the whole population. Per the saved
  proposal arithmetic, sequential creation of N bookings stores N(N+1)/2
  copied ReportBooking values (100→5,050; 10,000→50,005,000). Scalar-only
  changes (capacity, DayCalendar markers) recopy all four collections.
- G2 (empty vs unknown): no baseline marker. "Known empty" and "unknown
  prehistory" are both inferred from first-effective coverage; the
  `recorded_resource` fixture's empty collections are seeded present state,
  not proven past evidence.
- G3 (missed sites): a report-relevant mutation without a handwritten capture
  silently reuses older facts for later segments. Coverage depends on author
  discipline at 52 sites plus a per-change audit obligation.
- G4 (provenance): the checkpoint stamp and `Contribution.revision` are tied
  to full-snapshot row counts/sequences; raw row counts change under any
  representation fix while measure integrals must not.
- G5 (future ranges): `resource_report` permits future ranges via `now`
  fallbacks (`checked_out ?? now`); any redesign must preserve or explicitly
  re-decide that behavior, not silently alter it.

## 2. Decision and requirements text

Apply **ordinary locked per-entity report facts plus small resource-policy
captures**, with explicit writes at the existing capture sites. Narrow
`ResourceEvidence` to its four scalar fields. Add one fact model per existing
report collection (`BookingEvidence`, `VenueEvidence`, `WindowEvidence`,
`DowntimeEvidence`), each carrying the capture `sequence`, the source entity's
opaque canonical `key` (record ID), and a nullable typed value copy. Add an
explicit complete-baseline marker on `ResourcePolicy`. Reconstruct each
entity population in the report by latest-fact-at-or-before-sequence per key,
then omitting null values. Preserve the privileged report, all four metric
formulas, frozen interval buffers, pooled units, DST/opening construction,
current scope checks, and partial-coverage truthfulness.

This is the saved proposal's initial recommendation
(`design/rent-history-growth-20261004.md`, "Exact proposed Can
representation"), selected here because it is fully expressible in current
Can (models, locks, uniqueness, policies, invariants, derives, authored
effects) and current desired-JS conventions (DESIGN §13), requiring no
shared-language change.

Alternatives considered (evidence, not re-vote):

| Alternative | Evidence | Disposition |
| --- | --- | --- |
| Typed automatic history (`history` declarations + `history()` query + BDD `advance`) | Lane's later-selected contract; removes all manual capture sites | **Out of scope**: requires new Given syntax, a query intrinsic, runtime capture/coverage machinery, and a BDD clock extension — a shared language change this task forbids |
| Retain full snapshots + further same-admission coalescing | Coherent, easiest reconstruction; 52 sites verified working | **Not selected**: leaves G1 cross-admission growth unsolved and yields no A04 application; narrow coalescing remains valid only as local follow-ups |
| Rolling retention horizon / periodic checkpoints | Bounds storage | **Rejected**: changes retention and coverage requirements without reviewed authorization; checkpoints alone cannot replace required earlier intervals |

Coordinator-decided choices (user-authorized; explicitly flagged, never
silent). Items marked [proposal] adopt reviewed proposal text verbatim;
items marked [new] are genuine coordinator decisions with rationale:

- D1 [new]: select explicit facts over retain-current-form. The proposal left
  adoption open and the lane later preferred the out-of-scope typed route;
  with language change forbidden, explicit facts are the only replacement
  expressible in current Can. If Codex review prefers retention, the design
  collapses to §6 cases C1/C9/C13 as regression coverage of current behavior.
- D2 [new]: checkpoint stamp format. The proposal requires fact
  identities/sequences in the stamp but fixes no format. Use
  `policies + ":" + openings + ":" + bookingFacts + ":" + venueFacts + ":" +
  windowFacts + ":" + downtimeFacts`, each segment a comma-joined
  `id:sequence` list ordered by sequence (existing style; deterministic;
  opaque — old strings/counts are not preserved).
- D3 [new]: no installed-data backfill. Existing full snapshots keep serving
  as historical evidence until a separately evidenced migration/cutover;
  A04 is draft-source only. New resources establish `baseline=true` in the
  `Resource.create` hook over their known-empty collections.
- D4 [proposal]: null fact value is an explicit absence marker, never a
  missing-history guess. No current Booking/Venue/Window/Downtime path
  archives or permanently removes its entity (all CRUDs are `delete=none`;
  Booking has no crud), so this application writes no tombstones; the
  latest-then-omit-null reconstruction rule is still normative for any
  future removal path.
- D5 [proposal]: DayCalendar hooks keep marker-only captures. The old
  `ResourceEvidence` held no DayCalendar collection, so no new report input
  is invented there.
- D6 [new, mechanical]: keep every existing `policy_snapshot_N` binding name
  untouched; name each added fact binding after its entity with the same
  numeric suffix as its marker (`booking_evidence_1`, …). Rationale: binding
  uniqueness within an operation, minimal diff.
- D7 [proposal]: add `unique ResourcePolicy fields=sequence` (scoped within
  the parent Resource per DESIGN §2) and per-model `unique …Evidence
  fields=sequence,key`, all fields locked, reservation-manager + `can_work`
  read policies, and sequence-existence invariants.
- D8 [new, mechanical]: keep `saved_saleable(policy,opening,left,right)`
  signature; its body resolves facts via `policy.parent/policy.sequence`.
  Rationale: zero call-site churn; scalar-only captures still cannot change
  saleability inputs silently.
- D9 [new]: preserve current future-range semantics exactly (`checked_out ??
  now`, unclosed-occupancy provisional rule). The typed-history route added
  stronger forecast labeling; no new disclosure requirement was reviewed,
  so this application introduces no new provisional labeling.

**Requirements edits** (`draft/CanRent.md`): extend the "Resource reports"
paragraph to describe per-entity facts, the baseline marker, latest-per-key
reconstruction, the new opaque stamp, and the no-backfill cutover rule;
retain every statement about committed relevant state, partial coverage,
and report-integral preservation.

## 3. Exact affected files

1. `draft/CanRent.can`: Given evidence declarations + derives (§4), 52-site
   capture application map (§4), `resource_report` rewrite, fixture updates;
   no CRUD, page, policy (beyond the four new fact read rules), or
   Notice/delivery change.
2. `draft/CanRent.mjs`: fact model metadata, narrowed `resource_evidence`,
   new pure helpers, per-site capture lowering, `resource_report` handler,
   registry entries, fixture/example descriptors (§5). No new runtime/UI
   helper; no new imports beyond existing canonical modules.
3. `draft/CanRent.md`: accepted behavior text per §2; replace the
   full-snapshot growth paragraph, keep all coverage/authority statements.
4. `draft/MIGRATION.md`: coordinator evidence disposition only, after actual
   application and checks. No changes to DESIGN, GRAMMAR, REQUIREMENTS,
   compiler, library, or any other draft.

## 4. Can changed-section witness

In Given, keep the four `Report*` contracts (`:175-178`) and `saved_service`
(`:184`) byte-identical. Replace the `ResourceEvidence` contract,
`ResourcePolicy` model, `resource_evidence` and `saved_saleable`, and extend
the `ResourcePolicy` lock; keep its read policy (`:181`) unchanged:

```can
  contract ResourceEvidence { active:bool,capacity:int,pooled:bool,timezone:timezone }
  ResourcePolicy in Resource { effective:datetime server=now,sequence:int,baseline:bool=false,value:ResourceEvidence }
  unique ResourcePolicy fields=sequence
  lock ResourcePolicy fields=effective,sequence,baseline,value
  BookingEvidence in Resource { sequence:int,key:text,value:ReportBooking? }
  VenueEvidence in Resource { sequence:int,key:text,value:ReportVenue? }
  WindowEvidence in Resource { sequence:int,key:text,value:ReportWindow? }
  DowntimeEvidence in Resource { sequence:int,key:text,value:ReportDowntime? }
  unique BookingEvidence fields=sequence,key
  unique VenueEvidence fields=sequence,key
  unique WindowEvidence fields=sequence,key
  unique DowntimeEvidence fields=sequence,key
  lock BookingEvidence fields=sequence,key,value
  lock VenueEvidence fields=sequence,key,value
  lock WindowEvidence fields=sequence,key,value
  lock DowntimeEvidence fields=sequence,key,value
  policy BookingEvidence read=reservation_manager and can_work(actor,row.parent.location)
  policy VenueEvidence read=reservation_manager and can_work(actor,row.parent.location)
  policy WindowEvidence read=reservation_manager and can_work(actor,row.parent.location)
  policy DowntimeEvidence read=reservation_manager and can_work(actor,row.parent.location)
  invariant BookingEvidence: any(row.parent.ResourcePolicy as capture,capture.sequence==row.sequence)
  invariant VenueEvidence: any(row.parent.ResourcePolicy as capture,capture.sequence==row.sequence)
  invariant WindowEvidence: any(row.parent.ResourcePolicy as capture,capture.sequence==row.sequence)
  invariant DowntimeEvidence: any(row.parent.ResourcePolicy as capture,capture.sequence==row.sequence)
```

`key` is the source entity's opaque canonical record ID. Facts copy only the
existing report value — no billing amounts, contact data, or whole records.
No CRUD or user-callable fact writer is declared (ResourcePolicy precedent);
source code, not caller input, sets keys and sequences. Uniqueness rejects
accidental duplicate facts for one identity/capture; the owner operation
commits marker and facts atomically.

Projection and reconstruction derives (new; `report_booking` verbatim from
the reviewed proposal, the other three are coordinator-completed mechanical
analogs per D-decision notes, same field order as `resource_evidence`):

```can
  derive resource_evidence(resource:Resource):ResourceEvidence = ResourceEvidence {active=resource.active,capacity=resource.capacity,pooled=resource.pooled,timezone=resource.timezone}
  derive report_booking(booking:Booking):ReportBooking = ReportBooking {from=booking.from,until=booking.until,intervals=booking.intervals,quantity=booking.quantity,status=booking.status,checked_in=booking.checked_in,checked_out=booking.checked_out,arrival_buffer=booking.arrival_buffer,departure_buffer=booking.departure_buffer}
  derive report_venue(venue:VenueReservation):ReportVenue = ReportVenue {from=venue.from,until=venue.until,quantity=venue.quantity,status=venue.status}
  derive report_window(window:Window):ReportWindow = ReportWindow {from=window.from,until=window.until,closed=window.closed}
  derive report_downtime(downtime:Downtime):ReportDowntime = ReportDowntime {from=downtime.from,until=downtime.until,active=downtime.active}
  derive saved_bookings(resource:Resource,sequence:int):ReportBooking[] = flatten(group(resource.BookingEvidence as fact where fact.sequence<=sequence,fact.key) as item select (item.items as fact where fact==first(item.items as latest order=-latest.sequence) and fact.value!=null select fact.value))
```

`saved_venues`, `saved_windows`, `saved_downtime` substitute their actual
fact/value types in the same expression. Latest-per-key selection runs
**before** the null omission: filtering null first would resurrect a removed
entity. The `where … and fact.value!=null select fact.value` idiom follows
the established `!=null`-then-use precedent (`movement_reserved`,
`CanRent.can:457`); checking obligation is recorded in §7.

In `saved_rows` (`:174`) substitute `policy.value.bookings` →
`saved_bookings(resource,policy.sequence)` (3 sites: booked filter, occupied
filter, unclosed-occupancy provisional test) and `policy.value.venues` →
`saved_venues(resource,policy.sequence)`; `policy.value.pooled`,
`policy.value.capacity` and every quantity/status/interval/buffer predicate
stay unchanged. In `saved_saleable` (`:185`, D8) substitute
`policy.value.windows` → `saved_windows(policy.parent,policy.sequence)` and
`policy.value.downtime` → `saved_downtime(policy.parent,policy.sequence)`.

Capture pattern. The marker line is textually unchanged at all 52 sites
(the narrowed `resource_evidence` keeps its signature); each non-scalar site
appends one fact create sharing the marker sequence (D6 naming). Booking:

```can
    create ResourcePolicy {parent=booking.parent,sequence=count(booking.parent.ResourcePolicy)+1,value=resource_evidence(booking.parent)} as policy_snapshot_1
    create BookingEvidence {parent=booking.parent,sequence=policy_snapshot_1.sequence,key=booking.id,value=report_booking(booking)} as booking_evidence_1
```

Venue, Window and Downtime sites append `VenueEvidence` / `WindowEvidence` /
`DowntimeEvidence` with the same shape, using the operation's actual changed
entity for parent, key and value — `booking`, `event.booking`,
`adjustment.parent`, `venue`, `event.venue`, `downtime`, `event.after`
(Window hooks use `event.after` with `parent=event.after.parent`) — never an
unrelated collection scan. The 5 scalar sites (Resource create/update,
DayCalendar create/update, `revise_capacity`) keep the marker only; no new
report input is invented at DayCalendar (D5).

Application map (52 current sites; baseline inventory
`design/jev/rent-history-growth-20261004/capture-sites.json` minus the two
committed coalescings, both booking):

| Entity fact | Scenarios (sites) | Fact entity expression |
| --- | --- | --- |
| Booking (35) | `hold`, `hold_days`, `move`, `move_days` (1 each); `movement_result` (2: consumed-adopt + review branch); `quote_accept` (1, post-branch); `prepare` (2); `confirm_account` (3); `money` (6); `allowance_snapshot` (6); `charge_result`, `allowance_result`, `consumption`, `adjustment_money`, `arrive`, `depart`, `cancel_booking`, `expire`, `fulfill_free`, `no_show`, `refund_review` (1 each) | Operation's `booking` / `event.booking` / `adjustment.parent` |
| Venue (6) | `venue_hold`, `venue_stage`, `venue_confirm`, `venue_move`, `venue_release`, `venue_expire` | `venue` / `event.venue` |
| Downtime (4) | `block`, `restore`, `requested_downtime`, `requested_restore` | `downtime` |
| Window (2) | `snapshot_Window_create`, `snapshot_Window_update` | `event.after` |
| Scalar marker only (5) | `snapshot_Resource_create` (+`baseline=true`, D3), `snapshot_Resource_update`, `snapshot_DayCalendar_create`, `snapshot_DayCalendar_update`, `revise_capacity` | — |

In When, only `snapshot_Resource_create` changes its marker line:

```can
  scenario snapshot_Resource_create on=Resource.create
   do
    let resource=event.after
    create ResourcePolicy {parent=resource,sequence=count(resource.ResourcePolicy)+1,baseline=true,value=resource_evidence(resource)} as policy_snapshot_1
```

In `resource_report` (`:294-314`) keep the description, guards, `days`,
`openings`, `weekly`, `dated`, `midnight`, `boundaries`, `points` and both
returns unchanged. Replace the five edge collections, `complete`, and
`stamp`; `Contribution.revision` remains the selected resource capture
sequence:

```can
    let windows=flatten(resource.WindowEvidence as fact where fact.value!=null select [fact.value.from,fact.value.until])
    let downtime=flatten(resource.DowntimeEvidence as fact where fact.value!=null select [fact.value.from,fact.value.until ?? until])
    let service=flatten(resource.BookingEvidence as fact where fact.value!=null select [fact.value.from,fact.value.until,fact.value.checked_in ?? from,fact.value.checked_out ?? now])
    let access=flatten(resource.BookingEvidence as fact where fact.value!=null select flatten(fact.value.intervals as interval select [interval.from+fact.value.arrival_buffer,interval.until-fact.value.departure_buffer]))
    let venues=flatten(resource.VenueEvidence as fact where fact.value!=null select [fact.value.from,fact.value.until])
    let complete=any(policies as policy,policy.effective<=from and policy.baseline) and any(openings as policy,policy.effective<=from)
    let stamp=join((policies as policy order=policy.sequence select format("{id}:{sequence}",{id=policy.id,sequence=policy.sequence})),",")+":"+join((openings as policy order=policy.sequence select format("{id}:{sequence}",{id=policy.id,sequence=policy.sequence})),",")+":"+join((resource.BookingEvidence as fact order=fact.sequence select format("{id}:{sequence}",{id=fact.id,sequence=fact.sequence})),",")+":"+join((resource.VenueEvidence as fact order=fact.sequence select format("{id}:{sequence}",{id=fact.id,sequence=fact.sequence})),",")+":"+join((resource.WindowEvidence as fact order=fact.sequence select format("{id}:{sequence}",{id=fact.id,sequence=fact.sequence})),",")+":"+join((resource.DowntimeEvidence as fact order=fact.sequence select format("{id}:{sequence}",{id=fact.id,sequence=fact.sequence})),",")
```

Fixture updates (`:220-222`): narrow `recorded_resource` to the scalar value
with `baseline=true`, add a sequence-1 `WindowEvidence` recipe for its saved
opening window keyed at `test_window.id`, and add `test_window` to both
`resource_report` example seed lists. Existing observations (`complete=true`
with saleable 60; pre-baseline `complete=false` with 0 rows) are unchanged:

```can
  fixture recorded_resource=ResourcePolicy {parent=test_room,effective=now-2d,sequence=1,baseline=true,value=ResourceEvidence {active=true,capacity=1,pooled=false,timezone="Europe/Brussels"}}
  fixture recorded_window=WindowEvidence {parent=test_room,sequence=1,key=test_window.id,value=ReportWindow {from=now-2d,until=now+2d,closed=false}}
```

## 5. Desired JavaScript changed-section witness

Model metadata: extend `ResourcePolicy` with `baseline` and the sequence
unique; add the four fact models (`BookingEvidence` in full, the other three
substituting their `Report*` value type). Narrow the `ResourceEvidence`
contract descriptor to its four scalar fields; `Report*` contracts unchanged:

```js
    "rent_reservations.ResourcePolicy": {
      parent: "rent_reservations.Resource",
      readGrants: [{ rule: "ResourcePolicy.read.1" }],
      locks: ["ResourcePolicy.lock.1"],
      unique: [{ fields: ["sequence"] }],
      fields: {
        effective: { type: "datetime", server: "now" },
        sequence: { type: "int" },
        baseline: { type: "bool", default: false },
        value: { type: "rent_reservations.ResourceEvidence" },
      },
    },
    "rent_reservations.BookingEvidence": {
      parent: "rent_reservations.Resource",
      readGrants: [{ rule: "BookingEvidence.read.1" }],
      locks: ["BookingEvidence.lock.1"],
      invariants: ["BookingEvidence.invariant.1"],
      unique: [{ fields: ["sequence", "key"] }],
      fields: {
        sequence: { type: "int" },
        key: { type: "text" },
        value: { type: "rent_reservations.ReportBooking", nullable: true },
      },
    },
```

Pure helpers: narrowed `resource_evidence`, the four `report_*`
projections (`report_booking` in full), and the four `saved_*`
reconstructions (`saved_bookings` in full, following the existing
`collect`/`group`/sort idioms; every bucket is nonempty and per-key
sequences are unique):

```js
async function resource_evidence(c, resource) {
  return {
    active: resource.active,
    capacity: resource.capacity,
    pooled: resource.pooled,
    timezone: resource.timezone,
  };
}
function report_booking(c, booking) {
  return {
    from: booking.from,
    until: booking.until,
    intervals: booking.intervals,
    quantity: booking.quantity,
    status: booking.status,
    checked_in: booking.checked_in,
    checked_out: booking.checked_out,
    arrival_buffer: booking.arrival_buffer,
    departure_buffer: booking.departure_buffer,
  };
}
async function saved_bookings(c, resource, sequence) {
  const facts = await collect(records(c, "rent_reservations.BookingEvidence", {
    parent: resource, where: (fact) => fact.sequence <= sequence,
  }));
  const result = [];
  for (const bucket of await group(facts, (fact) => fact.key)) {
    const ordered = bucket.items.sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));
    const latest = ordered[ordered.length - 1];
    if (latest.value !== null) result.push(latest.value);
  }
  return result;
}
```

In `saved_rows`, `policy.value.bookings.filter(…)` becomes
`(await saved_bookings(c, resource, policy.sequence)).filter(…)` (3 sites)
and `policy.value.venues.filter(…)` becomes
`(await saved_venues(c, resource, policy.sequence)).filter(…)`; all
predicates, minute math, units and the provisional test stay unchanged. In
`saved_saleable`, preload
`const windows = await saved_windows(c, policy.parent, policy.sequence)` and
`const downtime = await saved_downtime(c, policy.parent, policy.sequence)`
and run the existing predicates over them (D8: signature unchanged).

Capture lowering: two ordinary creates per non-scalar site (existing
sequence idiom, no privileged helper):

```js
      const policy_snapshot_1 = await create(c, "rent_reservations.ResourcePolicy", {
        parent: booking.parent,
        sequence: (await count(records(c, "rent_reservations.ResourcePolicy", { parent: booking.parent }))) + 1n,
        value: await resource_evidence(c, booking.parent),
      });
      await create(c, "rent_reservations.BookingEvidence", {
        parent: booking.parent, sequence: policy_snapshot_1.sequence,
        key: booking.id, value: await report_booking(c, booking),
      });
```

In `resource_report`, replace the five edge collections with fact reads
(same map shapes as today), keeping guards, `days`/`openings`/`weekly`/
`dated`/`midnight`/`boundaries`/`points`/returns:

```js
      const factBookings = (await collect(records(c, "rent_reservations.BookingEvidence", { parent: resource }))).filter((fact) => fact.value !== null),
        factVenues = (await collect(records(c, "rent_reservations.VenueEvidence", { parent: resource }))).filter((fact) => fact.value !== null),
        factWindows = (await collect(records(c, "rent_reservations.WindowEvidence", { parent: resource }))).filter((fact) => fact.value !== null),
        factDowntime = (await collect(records(c, "rent_reservations.DowntimeEvidence", { parent: resource }))).filter((fact) => fact.value !== null);
      const windows = flatten(factWindows.map((fact) => [fact.value.from, fact.value.until])),
        downtime = flatten(factDowntime.map((fact) => [fact.value.from, fact.value.until ?? until])),
        service = flatten(factBookings.map((fact) => [fact.value.from, fact.value.until, fact.value.checked_in ?? from, fact.value.checked_out ?? c.now])),
        access = flatten(factBookings.map((fact) => flatten(fact.value.intervals.map((interval) => [addDuration(interval.from, fact.value.arrival_buffer), subtractDuration(interval.until, fact.value.departure_buffer)])))),
        venues = flatten(factVenues.map((fact) => [fact.value.from, fact.value.until]));
      const complete =
          (await any(policies, (policy) => compareInstant(policy.effective, from) <= 0 && policy.baseline)) &&
          (await any(openings, (policy) => compareInstant(policy.effective, from) <= 0)),
        stamp = [policies, openings].map((rows) => rows.sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0)).map((row) => format("{id}:{sequence}", { id: row.id, sequence: row.sequence })).join(",")).join(":")
          + ":" + [factBookings, factVenues, factWindows, factDowntime].map((rows) => rows.sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0)).map((row) => format("{id}:{sequence}", { id: row.id, sequence: row.sequence })).join(",")).join(":");
```

Rule maps (one per fact model; `BookingEvidence` representative, following
the existing async read-rule and lock/invariant descriptor shapes):

```js
      "BookingEvidence.read.1": async (c, row) => hasRole(c, reservation_manager) && await can_work(c, c.actor, row.parent.location),
      "BookingEvidence.lock.1": { fields: ["sequence", "key", "value"] },
      "BookingEvidence.invariant.1": async (c, row) => await any(records(c, "rent_reservations.ResourcePolicy", { parent: row.parent }), (capture) => capture.sequence === row.sequence),
```

plus `ResourcePolicy.lock.1` extended to
`["effective", "sequence", "baseline", "value"]`. Derives registry gains
`report_booking`/`report_venue`/`report_window`/`report_downtime` and
`saved_bookings`/`saved_venues`/`saved_windows`/`saved_downtime` entries
mirroring the `resource_evidence`/`saved_rows` descriptor shapes. No
`disabled` additions: like `ResourcePolicy`, the fact models have no crud
and no page/tool exposure (Rent-local precedent; the Purchase closed-world
variance is noted — if Codex settles it for Rent, the 12 mechanical
create/update/delete identities are the only addition).

Fixtures/examples: the `recorded_resource` descriptor gains `baseline: true`
and the narrowed value; add `recorded_window` (`{model:
"rent_reservations.WindowEvidence", dependencies: [test_room, test_window],
value: async (c, s) => ({ parent: s.test_room, sequence: 1n, key:
s.test_window.id, value: { from: …, until: …, closed: false }})}`); both
`resource_report` example descriptors gain `test_window` in seed and
dependencies. Observations are unchanged.

## 6. Required cases including failure and recovery

Acceptance obligations for the A04 application. "Isolated table" cases are
implementable now (single call + seeded facts); "specified journey" cases
need genuine committed calls at distinct instants and are specified here as
required outcomes for a future clock-capable sequence — per DESIGN §5.1,
isolated rows seeded at successive states do not prove the journey.

| ID | Case | Required preserved outcome | Form |
| --- | --- | --- | --- |
| C1 | New resource, no items | Zero booked/occupied; denominator only from saved openings/windows; `complete=true` via creation baseline | Isolated table (seed `recorded_resource` + `recorded_window`) |
| C2 | Confirmed booking, later cancellation | Booked service follows effective saved states; earlier segment unchanged | Specified journey |
| C3 | Cancellation while checked in | Occupancy continues to actual checkout; cancellation/refund never pretends physical clearance | Specified journey |
| C4 | Late checkout beyond planned end | Saved occupancy + provisional persist until real departure; service and physical minutes stay separate | Specified journey |
| C5 | Changed pooled capacity / window / downtime | Old denominator uses old values; changes take effect only at their saved capture; reopening never erases prior exclusion | Specified journey |
| C6 | Daylight-saving transition | Same saved timezone/fold boundaries and exact elapsed minutes; no 24-hour shortcut | Specified journey |
| C7 | Same-admission multi-set (move + intervals; quote accept + charge branch) | Only final committed state wins; no intermediate state gets positive-duration coverage | Specified journey |
| C8 | Null-latest fact reconstruction | Null latest value removes the entity; older value cannot be resurrected by filtering null before latest selection | Isolated table (seeded facts; no current tombstone writer per D4) |
| C9 | Missing baseline or LocationPolicy | Partial checkpoint, unknown segments omitted; never a complete-empty claim from missing facts | Isolated table (pre-baseline range; existing example kept) |
| C10 | Permission loss / denial | Deactivated or non-manager caller gets `forbidden` from `resource_report`; fact models unreadable outside reservation-manager + `can_work`; customer/reception booking grants grant no history | Isolated table (caller matrix) |
| C11 | Rejected admission | `rule_failed` / `conflict` / `validation` commits no marker and no fact — all-or-nothing with the owner operation | Isolated table (existing rejection-row style) |
| C12 | Failed provider callback | Review branch captures review state once (`movement_result` review path); failed-charge/allowance branches trigger only the sales check, never duplicate customer notices | Specified journey |
| C13 | Legacy intake regression | `retain_legacy` / `link_legacy` / CSV review behavior byte-identical; duplicate source key → `rule_failed`; LegacyBooking still excluded from reports and live state | Isolated tables (existing 13 cases kept) |
| C14 | Stamp and revision opacity | New stamp certifies the actual evidence set (policies + openings + four fact lists); old strings/counts not preserved; `Contribution.revision` stays the selected capture sequence | Static correspondence |

## 7. Advice, checks and remaining limits

Prior advice (not re-voted): three original JEV choice requests split
(.80/.82 for explicit facts; .68 for a temporal query in #3 with no textual
rationale). Revised briefs #4/#6 favor typed history (.95/.76) but disagree
on the clock (`advance` .73 vs .36); request #5 was twice rejected by
automatic approval review and awaits exact-payload human approval, so the
revised round is incomplete. All requests/responses/rejections are saved
under `design/jev/rent-history-growth-20261004/`. No new JEV round was run
for this handoff: the existing advice already covers these exact competing
approaches, and the selection follows the no-shared-language-change scope
constraint plus reviewed evidence, not a preference vote. JEV advice remains
advice, never approval or runtime proof.

Checks run for this design (scaffold/wrapper only; no app file touched):

- `python3 tools/can_parser.py /tmp/history-scaffold.can` → exit 0,
  "Parsed 1 .can files (syntax only)." The scaffold carries every new
  declaration shape (narrowed contract, `baseline` default, four fact
  models with unique/lock/policy/invariant, `saved_bookings`
  group/flatten/latest reconstruction), the two-create capture pattern,
  and the fact-edge + baseline-coverage report expressions.
- `node --check /tmp/history-witness.mjs` → exit 0. The wrapper carries
  the metadata blocks, rule maps, narrowed `resource_evidence`,
  `report_booking`, `saved_bookings`, the capture lowering, and the
  report edge/complete/stamp fragment with stubbed canonical helpers
  (unexecuted).

Remaining limits (explicit, not hidden): syntax/static evidence only — no
type checker, permission evaluator, import linker, BDD runner, report runner,
or disposal test executed. Checking obligations for implementation/Codex
review: (a) the `where … and fact.value!=null select fact.value` narrowing
idiom against the `movement_reserved` precedent; (b) async-invariant
lowering convention for the sequence-existence rule; (c) per-change capture
coverage audit for any future report-relevant mutation (a missed site
silently reuses older facts, as today). No installed-data backfill is
specified (D3). Unknown runtime correctness is not claimed. Codex C01/C02
review follows.
