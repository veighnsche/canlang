# Rent historical capture growth — 2026-10-04

**Current status:** the lane recommends the [typed-history contract](#selected-bounded-contract-after-the-challenge), but the project has not adopted it. Shared specifications and Rent retain the existing representation with the two committed local coalescings. The revised three-request consultation is incomplete: request #5 awaits exact-payload approval after automatic approval review rejected it. Source/target extracts and token measurements are proposal evidence, not generated or executed output.

## Initial recommendation — superseded below

The final recommendation is [Selected bounded contract after the challenge](#selected-bounded-contract-after-the-challenge). Earlier proposals and disagreement remain below as decision evidence. Revised consultation #5 is pending exact-payload approval; no app/shared implementation is implied.

Use **ordinary locked per-entity report facts plus small resource-policy captures**, with explicit writes at the existing capture sites. Preserve the existing privileged report and its business calculations. Do not introduce a temporal-query primitive or assume that the audit UI is a historical query API. First coalesce the two demonstrated same-admission chains below; then apply the normalized representation as one checked report/capture change. No app/shared files were edited here.

This changes an internal representation, including raw ResourcePolicy enumeration and checkpoint sequence/ID strings. It preserves required historical measures, evidence provenance and truthful coverage, not byte-identical internal row counts or revision numbers. All reports remain subject to present scoped authority. No runtime/library implementation or measured performance claim is made.

## Actual current evidence

`CanRent.can:156–166` stores a complete `ResourceEvidence` in each locked ResourcePolicy: active/capacity/pooled/timezone plus every report window, downtime, booking and venue. `resource_evidence` in CanRent.mjs explicitly materializes those four collections. There were **55 source capture sites at the initial inspection**, inventoried in [capture-sites.json](jev/rent-history-growth-20261004/capture-sites.json): 38 booking-related, 6 venue, 4 downtime, 2 window, 5 scalar/resource/calendar sites. The committed coalescings reduce the current count to 52; the final comparison below uses that newer baseline.

The report at CanRent.can:238–257 selects the latest resource and LocationPolicy sequence effective at each segment start. It derives boundaries from saved calendars, policies, windows/downtime, booking/service/access intervals and actual occupancy. It emits booked, occupied, saleable and excluded minutes; units distinguish seat-minutes from room-minutes. It marks unclosed saved occupancy provisional. Coverage before the first saved resource or opening evidence is partial rather than a claimed zero. No ResourcePolicy retention is declared.

The current `resource_report` is `read=true scope=authority -> ReportBatch by=reservation_manager`, additionally requiring current `can_work(actor,resource.location)` and `from<until`. Evidence rows also have the current scoped reservation-manager read policy. The automatic UI history facility does not declare a typed historical read API. New facts must retain that evidence authority; customer/reception booking grants do not become history grants.

### Demonstrated local reductions

1. `quote_accept:749/753`: a capture immediately follows Booking creation; a positive-total branch sends the charge, sets status pending and captures again. Replace those two capture statements with one at the outer booking scope **after the positive-total branch and before schedule/OfferOutcome**. The zero-total branch still captures once; the positive branch captures its final report state once. Keep charge, booking write, schedule and outcome order intact. Neither deleted capture binding is otherwise used.
2. `movement_result:435/438/441`: the successful consumed branch first changes from/until, captures, then chooses either day intervals or an empty interval array and captures in either branch. Remove these three capture statements and insert one after that intervals if/else, before `set movement {state=adopted,...}`. The separate review branch at :448 retains its capture. Each successful branch then stores the same final booking projection once.

No `on=ResourcePolicy` handler, `policy_snapshot_*` consumer or internal `call resource_report` was found in the app sources. Nevertheless, ResourcePolicy has an authorized model interface: deleting these rows changes raw evidence enumeration. The changed contract is explicit: report evidence describes committed relevant state, not each intermediate same-clock statement as a separately promised business event. Automatic business-row audit remains separate. Same-admission `now` is fixed, so the intermediate policy never wins the latest-sequence selection for a positive-duration interval after commit. Its incidental extra boundary points may disappear; comparisons must use the common refinement of intervals and exact metric integrals, not demand identical segment count or opaque revision strings.

Other nearby captures are not automatically duplicates. For example `confirm_account` branches and independently gated `money` branches require path-sensitive examination; deleting a capture merely because the same resource appears later in the source is unsafe. The finite inventory is a mapping aid, not proof that every pair can merge.

## Advice, uncertainty and alternatives

Three freshly rewritten facts-only choice requests and complete responses are saved in [the consultation folder](jev/rent-history-growth-20261004). No source dumps or credentials were attached.

| Request | Explicit facts | New version query | Coalesced full snapshots | Selected | Confidence |
| --- | ---: | ---: | ---: | --- | ---: |
| 1 | .80 | .07 | .13 | Explicit facts | .70 |
| 2 | .82 | .01 | .17 | Explicit facts | .73 |
| 3 | .22 | .68 | .10 | New version query | .52 |

There is real disagreement. The third consultation strongly favors centralizing capture in a new transaction-final temporal API. The responses provide no textual rationale, so none is attributed to them. Investigation of that alternative found a genuine potential advantage—less app capture bookkeeping—but no current contract for temporal selection, selected fields, deletion, retention, incomplete intervals or historical disclosure. Specifying it would be a broader language decision than correcting this app's repeated copies. Explicit facts are selected here because their full representation is expressible using current models, locks, uniqueness, queries and authored effects; this is a bounded judgment, not a vote or confidence threshold.

Full snapshots plus only the local coalescing remain coherent and easier to reconstruct. They do not remove cross-admission growing-list copies. Periodic full checkpoints can bound replay distance but still recopy the population; checkpoints alone cannot replace earlier state when all earlier historical intervals remain required. A shorter rolling history horizon would change retention and coverage requirements and is not selected. No cost saving is attributed to dropping evidence. The explicit-fact route instead pays for additional schema/capture bookkeeping and historical joins; actual query CPU, byte storage, latency and stewardship cost remain unmeasured.

## Exact proposed Can representation

Retain the existing ReportWindow, ReportDowntime, ReportBooking and ReportVenue schemas, including the complete current ReportBooking interval/quantity/status/actual-occupancy/buffer fields. Narrow ResourceEvidence to the scalar resource-policy value. Add an explicit complete-baseline marker and one fact type per existing report collection:

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
derive resource_evidence(resource:Resource):ResourceEvidence = ResourceEvidence {active=resource.active,capacity=resource.capacity,pooled=resource.pooled,timezone=resource.timezone}
derive report_booking(booking:Booking):ReportBooking = ReportBooking {from=booking.from,until=booking.until,intervals=booking.intervals,quantity=booking.quantity,status=booking.status,checked_in=booking.checked_in,checked_out=booking.checked_out,arrival_buffer=booking.arrival_buffer,departure_buffer=booking.departure_buffer}
```

`key` is the source entity's opaque canonical ID, not a name, customer account or array index. Separate fact models make equal IDs across entity types unambiguous. Facts copy only the existing report value, not billing amounts, contact data or whole source records. The sequence refers to the small policy capture committed in the same operation. Source code, not caller input, sets keys/sequences; no CRUD or user-callable generic fact writer is declared. Uniqueness rejects accidental duplicate facts for one identity/capture. The complete owner operation commits or rolls back marker and facts together.

At a booking capture site, replace the full snapshot with:

```can
create ResourcePolicy {parent=booking.parent,sequence=count(booking.parent.ResourcePolicy)+1,value=resource_evidence(booking.parent)} as policy_snapshot
create BookingEvidence {parent=booking.parent,sequence=policy_snapshot.sequence,key=booking.id,value=report_booking(booking)} as booking_evidence
```

For event.booking or adjustment.parent, use that actual Booking expression, not an unrelated current collection scan. Venue, Window and Downtime sites append their corresponding typed projection using the same capture sequence and source entity ID. Scalar Resource updates/revise_capacity require only the small ResourcePolicy row. Current DayCalendar hooks retain their marker; the old ResourceEvidence did not contain a DayCalendar collection, so this change must not invent a new report input there. LocationPolicy capture and interpretation remain unchanged.

The Resource.create precommit hook writes `baseline=true` for its known-empty newly created resource. All later entity creations/changes use the explicit site pattern. A baseline over a nonempty preexisting resource requires a fenced complete initial capture of **all four** current collections with actual source IDs before marking baseline complete. This is a one-time initialization, not a recurring full copy. Without such evidence, leave baseline false and report earlier coverage partial. The present sample `recorded_resource` fixture must add baseline=true and a sequence-1 WindowEvidence recipe for its saved opening window; do not silently treat absent initialized collections as empty evidence.

A null fact value is an explicit absence/tombstone, never a missing-history guess. Current Booking/Venue/Window/Downtime report entities have no ordinary archive/delete path requiring such a fact in the inspected capture surface; cancellation, expiration and restored downtime remain their existing nonnull status/active values. Any future archive/permanent-removal/retention path that can remove a source entity from a full snapshot must synchronously append its tombstone before removal, or explicitly make coverage incomplete; retaining its last live fact forever would not preserve the previous representation's membership semantics. No fact/history retention is added here.

## Reconstruction using existing queries

For each entity type, select the latest fact at or before the chosen ResourcePolicy sequence, **then** omit null values. Filtering null first would resurrect a removed entity. The booking derive is representative; the other three substitute their actual fact/value types:

```can
derive saved_bookings(resource:Resource,sequence:int):ReportBooking[] = flatten(group(resource.BookingEvidence as fact where fact.sequence<=sequence,fact.key) as item select (item.items as fact where fact==first(item.items as latest order=-latest.sequence) and fact.value!=null select fact.value))
```

Use `saved_venues`, `saved_windows` and `saved_downtime` with the same selection rule. These are ordinary authored pure derives with actual declarations, not a runtime history-query API. Their authority is inherited exactly as today's saved_rows helper. The ResourcePolicy read policy remains unchanged.

In `saved_rows`, substitute:

- `policy.value.bookings` → `saved_bookings(resource,policy.sequence)`.
- `policy.value.venues` → `saved_venues(resource,policy.sequence)`.
- `saved_saleable`'s windows/downtime → `saved_windows(policy.parent,policy.sequence)` and `saved_downtime(policy.parent,policy.sequence)`.

Leave every existing quantity/status/interval/buffer/arrival/departure predicate, saleability calculation and unit expression unchanged. In particular, the existing provisional test is `any` unclosed saved occupancy, not merely an overlap-filtered subset. Cancellation may remove booked service while occupancy continues until an actual checkout; payment/refund states do not themselves erase physical occupancy. Price/currency, invoice settlement and reversal records are not capture inputs and do not change.

For report boundary generation, collect the existing interval edges from every nonnull **fact value**, instead of every copy embedded in ResourcePolicy.value. Include all ResourcePolicy.effective and LocationPolicy.effective edges as before; grouping duplicate points and `next_boundary` stay unchanged. Keep location weekly/dated timezones, folds, local-day construction and midnight logic exactly as currently authored. Do not replace DST-aware instants with fixed 24-hour arithmetic or silently change the report timezone rules.

Require a known baseline effective at/before the segment start before emitting its measures. Whole-range `checkpoint.complete` requires a baseline at/before `from` and the existing opening-policy coverage; missing baseline/opening history yields partial output, never zero. The checkpoint stamp must include the immutable fact identities/sequences as well as policy/opening identities/sequences, so its identity reflects the actual saved evidence set. It is an opaque new representation stamp, not the old byte string. Contribution.revision remains the selected resource capture sequence. Current can_work authority, current resource lookup, range bounds and bounded-read failure behavior remain unchanged.

Do not backdate later corrections: a new explicit fact takes effect through its actual admission's ResourcePolicy timestamp. Historical state before it remains the older fact. A deliberate past-source correction would require its own declared business semantics; this redesign does not infer one from current Booking fields. If existing retained full snapshots lack stable entity IDs, never infer identities by matching equal values or array positions. Keep those snapshots as their historical evidence source, or perform an explicitly evidenced migration/cutover; that installed-data problem cannot be solved by pretending current rows prove old identities. The draft has no implemented deployment compatibility gate, but it still must not fabricate migration evidence.

## Desired JavaScript mapping

Fact metadata uses ordinary model declarations, for example:

```js
"rent_reservations.BookingEvidence": {
  parent: "rent_reservations.Resource",
  fields: {
    sequence: {type: "int"}, key: {type: "text"},
    value: {type: "rent_reservations.ReportBooking", nullable: true},
  },
  unique: [{fields: ["sequence", "key"]}],
  locks: ["BookingEvidence.lock.1"],
  invariants: ["BookingEvidence.invariant.1"],
  readGrants: [{rule: "BookingEvidence.read.1"}],
}
```

The read rule is the existing reservation-manager role and can_work at the parent location. Locks contain sequence/key/value; its invariant queries the same-parent capture sequence in ordinary invariant authority. Narrow `resource_evidence(c,resource)` to its four scalar properties. The source capture above lowers to two ordinary creates:

```js
const policy_snapshot = await create(c, "rent_reservations.ResourcePolicy", {
  parent: booking.parent,
  sequence: int64(await count(records(c, "rent_reservations.ResourcePolicy", {parent: booking.parent})) + 1n),
  value: await resource_evidence(c, booking.parent),
});
await create(c, "rent_reservations.BookingEvidence", {
  parent: booking.parent, sequence: policy_snapshot.sequence,
  key: booking.id, value: await report_booking(c, booking),
});
```

`report_booking` is the pure lowering of the explicitly authored derive above. No privileged write helper, deferred asynchronous capture or unimplemented `historyAt` call is introduced. A report-side lowering may materialize authorized fact records once and group them:

```js
async function saved_bookings(c, resource, sequence) {
  const facts = await collect(records(c, "rent_reservations.BookingEvidence", {
    parent: resource, where: fact => fact.sequence <= sequence,
  }));
  const result = [];
  for (const bucket of await group(facts, fact => fact.key)) {
    const latest = bucket.items.reduce((left, right) =>
      left.sequence > right.sequence ? left : right);
    if (latest.value !== null) result.push(latest.value);
  }
  return result;
}
```

Every bucket is nonempty and the per-key sequence is unique. The tuple's canonical source semantics are the derive, not this implementation strategy. Existing typed decimal/duration helpers still compute minute contributions; do not convert BigInt timestamps/money or quantities through JavaScript Number. Intermediate same-admission capture coalescing does not move any existing business guard, provider send, schedule, commit event or return.

## Application map and bounded verification

The checked inventory is the source application map: 38 booking sites append BookingEvidence for their actual booking expression; 6 venue sites append VenueEvidence; 4 downtime sites append DowntimeEvidence; 2 Window hooks append WindowEvidence from event.after; 5 scalar sites append only the scalar policy. After the two demonstrated coalescings, update the affected counts/inventory rather than assuming 55 independent final admissions. The comparison of report-relevant `set`/`create` paths found captures next to current from/until/interval/status/arrival/departure, window and downtime changes; future mutations need the same explicit coverage audit. Changes to Movement/Conflict/payment-only fields do not invent new report values.

Before applying the full normalized representation, check these same-state cases against both representations, comparing exact contributions on their common time partition:

| Case | Required preserved outcome |
| --- | --- |
| New resource, no source items | Zero known booked/occupied; denominator only from actual saved openings/windows; no pre-baseline zero claim. |
| Confirmed booking, later cancellation | Booked service follows effective saved states; original earlier segment remains unchanged. |
| Cancellation while checked in | Occupancy continues to actual checkout; cancellation/refund does not pretend physical clearance. |
| Late checkout beyond planned end | Saved actual occupancy and provisional state persist until the real departure; service and physical minutes remain separate. |
| Changed pooled capacity/window/downtime | Old denominator uses old values; changes take effect only at their saved capture; reopening does not erase previous exclusion. |
| Daylight-saving transition | Same saved timezone/fold boundaries and exact elapsed minutes; no 24-hour shortcut. |
| Same-admission from/until plus interval update | Only final committed state wins; no intermediate state gets positive-duration historical coverage. |
| Tombstone then later reappearance | Null latest value removes the entity; older value cannot be resurrected by filtering null before latest selection. |
| Missing baseline or LocationPolicy | Partial checkpoint with unknown segments omitted; never infer complete empty history from missing facts. |
| Permission loss or expired evidence | Current scoped report denial/ordinary lifetime behavior persists; no copied account/private source grant is added. |

These are acceptance obligations, not executed tests. The proposed schema and reconstruction derive parse with the initial syntax parser when wrapped in an isolated app/Given/When/Then scaffold; that parser does not resolve symbols, infer nullable narrowing, check authority or run reports. The illustrative JavaScript metadata/capture/reconstruction blocks pass `node --check` in a temporary wrapper; imports and helper behavior are unexecuted. All three saved response requests match their separate request files. Saved source facts and desired JavaScript inspection are not a report runner. No parser/compiler/library implementation, app edit, general history framework or staging/commit was performed.

## Logical growth observation

Under the same deliberately narrow case of one capture per sequential booking creation and no later updates, the old snapshots contain:

| Bookings | Old repeated ReportBooking values | Proposed ReportBooking fact values |
| ---: | ---: | ---: |
| 100 | 5,050 | 100 |
| 1,000 | 500,500 | 1,000 |
| 10,000 | 50,005,000 | 10,000 |

The proposal also retains the small policy captures and every actual changed Window/Downtime/Venue value. Updates append new values for their own identities; a growing interval array inside one booking can still be copied across that booking's revisions. Thus this removes unrelated growing-population copying, not all possible history growth. Report reconstruction now performs joins/grouping and can still require significant bounded work; no query complexity, byte, token, latency, Cloudflare price or total company saving is established by this arithmetic.

The smallest immediate source change is the two local coalescings. The smallest complete cross-admission fix is the four typed evidence models, scalar ResourceEvidence, explicit baseline, matching per-site writes and revised report joins/boundaries/stamp **together**. Shipping only the narrowed capture without reconstruction/baseline rules would falsify history and is not recommended.

## Reopened comparison: bounded typed automatic history candidate

**Decision status: the earlier explicit-facts recommendation is provisional pending this comparison.** The absence of a temporal query in the current draft is not an adoption argument against defining one. The real comparison is five retained history projections and one typed query contract versus four evidence models, their rules, approximately fifty authored capture writes, and reconstruction. This section specifies a candidate; it does not adopt or implement it. The existing three consultations already cover the competing approaches and their disagreement remains evidence, not a reason to re-vote.

### Candidate source surface

Permit a Given declaration that selects a *closed, same-name, stored-field projection* of automatic row history into an existing value contract. `as` does not infer renames, joins, derives or authority from that contract. Each contract field must have the same resolved type as its source stored field. Only those fields and protected history identity/order metadata are retained. The candidate declarations for Rent are:

```can
history Resource as ResourceEvidence until=null read=reservation_manager and can_work(actor,row.location)
history Booking as ReportBooking until=null read=reservation_manager and can_work(actor,row.parent.location)
history VenueReservation as ReportVenue until=null read=reservation_manager and can_work(actor,row.parent.location)
history Window as ReportWindow until=null read=reservation_manager and can_work(actor,row.parent.location)
history Downtime as ReportDowntime until=null read=reservation_manager and can_work(actor,row.parent.location)
```

Here ResourceEvidence contains only active/capacity/pooled/timezone, as in the earlier proposal. The existing ReportBooking/ReportVenue/ReportWindow/ReportDowntime contracts already name the required source fields exactly. At most one such declaration per source model in this bounded candidate. This is selected retention of existing automatic versions, not another mutable model, duplicate write API or generic computed materialized view. `until=null` gives the selected audit projection no independent deadline rather than the default 90-day audit horizon; it does not retain the unselected Booking customer/email/payment fields. Finite `until` uses the existing owner-local lifetime-expression restrictions. Source/ancestor content expiry still overrides retention (§7.1); see the explicit equivalence limit below.

The query is a new typed intrinsic, fully defined here rather than assumed to exist:

```can
let bookings=history(resource.Booking,from,until)
let at_left=history_at(bookings,left)
```

The first argument is exactly a model collection path with its resolved current parent, or one current model reference (`history(resource,from,until)`). No `where`, sort, viewer-filtered collection, dynamic model or remote-parent traversal is accepted there. Filter *after* historical reconstruction, so current predicates cannot erase old members. The model must have the declaration. Result type is `History<ReportBooking>` for the collection; the single-record form uses the same container with zero or one value. `history_at` is a pure typed operation on that result, not another storage query. Range is half-open `[from,until)` and requires `from<until`; point must satisfy `from<=point<until`.

### Exact value and ordering semantics

`History<T>` contains `from:datetime`, `until:datetime`, `baseline:HistoryValue<T>[]?`, `baseline_sequence:int?`, `changes:HistoryChange<T>[]`, `checkpoints:HistoryCheckpoint<T>[]`, `unavailable:HistoryGap[]`, `complete:bool`, and `revision:text`. A HistoryCheckpoint has effective:datetime, sequence:int and values:HistoryValue<T>[]; a HistoryGap has from:datetime and until:datetime. Checkpoints represent complete initialization/re-established coverage, not every normal mutation. Gaps disclose only unavailable time coverage to an admitted reader, no missing identities or values. `HistoryValue<T>` has opaque `key:text` and `value:T`. `HistoryChange<T>` has `key:text`, `effective:datetime`, `sequence:int`, and `value:T?`. A null change is absence at that cutoff (archive or permanent removal); it is distinct from unavailable evidence. These are compiler-recognized immutable values, never model references. `history_at` returns `{complete:bool,values:HistoryValue<T>[]}`; if evidence needed at the requested point is unavailable, complete=false and values=[] rather than a deceptively partial population. The caller must test complete before treating empty as zero. Extra unavailable intervals are represented by failed completeness at the points they cover, not a null tombstone. history_at first rejects points inside an unavailable gap. Otherwise it selects the latest complete checkpoint at/before the point, falling back to baseline at from, and applies later changes through the point in sequence order. With neither checkpoint nor baseline it returns incomplete. The returned coverage/checkpoints are runtime-produced typed immutable values, not author-writable source metadata.

Baseline is the exact active population at `from` after all commits effective at/before `from`; null means that population is not established. Changes expose later committed projection changes within the range. An unknown initial baseline can become known after a recorded complete initialization within the range; `history_at` uses that returned complete checkpoint. A baseline of [] is allowed only for proven empty population, such as a newly created parent with history enabled. Enabling history on existing data establishes a current fenced population baseline, not fabricated past versions. No current-row scan establishes earlier coverage. A partially purged interval is incomplete even if surviving values look plausible. `complete` means every point in the entire requested range is reconstructable; it is not merely “some baseline exists.”

Every selected source mutation participates in the existing owner commit: successful final values after calls/hooks, one version per written row, no failed or replayed write. Create followed by multiple provisional sets contributes the final value once. A write that leaves all selected fields unchanged need not add a projection change; ordinary row version/audit still records its write intent. Archive/removal contributes absence at that commit; prior retained values remain historical content when permitted. A create followed by removal within one admission has no externally committed member. The collection's opaque revision includes the ordered retained coverage/change identity relevant to the requested range; callers cannot interpret it as a row version.

`sequence` is the existing owner's monotonically increasing successful commit order, shared across all five projections. `effective` uses the same admitted fixed instant as the old saved capture; equal instants resolve by highest sequence. History at a boundary observes all selected rows from a commit or none. If clock rollback can make admitted instants nonmonotonic, the language must define a nondecreasing owner-effective clock for *both* historical mechanisms before claiming real-time equivalence; silently sorting wall-clock values differently is not a fix. Changing intermediate capture sequence numbers to commit sequences is an explicit provenance change. No historical value can be passed as an existing record argument, submitted for a write, or grant expected-version authority. Opaque keys support grouping/stamps only; lookup of a real current row remains an ordinary authorized lookup.

All five storage reads and the current scope guard remain in the existing same-owner revision fence. A concurrent permission/data/history-disposal change retries the whole read. Query work beyond the bound fails with the established bounded-read outcome rather than silently truncating old rows. No cross-owner history join or newly atomic Location read is introduced; existing LocationPolicy evidence stays as it is.

### Disclosure and lifetime

The declaration's read expression is the historical projection's ordinary viewer grant, evaluated using current authority and the current source containment location. It does not copy the source model's public or customer grants. `row` in this rule resolves the current source identity/containment for authorization, not a past actor's roles and not whichever historical value is being rendered. For archived/removed children, protected retained parent identity resolves the current Resource; it does not expose old child fields to evaluate a new permission. If the required current authorization anchor no longer exists or is unavailable, access denies. A removed Resource therefore does not acquire a report entry point. General history-grant expressions needing unavailable current row fields deny; this Rent witness uses only the surviving parent location. Current Resource.location is immutable in the inspected CRUD surface; no old location membership is inferred.

Authority reads retain normal Can authority semantics: the existing exported `resource_report by=reservation_manager` and current can_work guard admit its same-owner reads. They do not acquire new browser/MCP history tools. Ordinary UI history access uses the explicit projection grant; unauthorized rows/fields cannot be used to infer population completeness or identities. The contract returns a permission failure when a requested declared projection is not wholly readable in viewer mode, rather than a filtered timeline that claims complete population. This restriction is necessary for a report primitive; ordinary filtered list behavior would produce false zeroes. Expired content is not recoverable in authority mode either. A history declaration grants no file content authority; selected file values, if later permitted, would retain current attachment/lifetime checks. This Rent subset has no file fields or model-reference fields in the projected values.

### Concrete source and desired-JS delta

Remove ResourcePolicy, its lock/read rule, `resource_evidence`, and all 55 manual capture statements (including capture-only hooks). Keep each actual business mutation, guard, send, schedule, event and return in order. Keep LocationPolicy and its opening-time behavior. The four Report* contracts remain, plus the narrowed ResourceEvidence and the five declarations above. Current DayCalendar mutations do not affect these five projections; their old otherwise-empty ResourcePolicy markers disappear without changing metrics. CapacityRevision continues as actual authored business evidence.

At the start of `resource_report`, load each timeline once:

```can
let resources=history(resource,from,until)
let bookings=history(resource.Booking,from,until)
let venues=history(resource.VenueReservation,from,until)
let windows=history(resource.Window,from,until)
let downtime=history(resource.Downtime,from,until)
```

Derive boundaries from baseline values and every nonnull change's existing business interval edges, plus every timeline change effective instant and the existing LocationPolicy/weekly/dated/midnight points. At each left boundary, call history_at on those five values, require all five complete plus known LocationPolicy before emitting a segment, and use their `.values as item select item.value` in the exact existing metric predicates. Resource active/capacity/pooled/timezone comes from the sole historical resource value. No lookup of current Booking intervals, current product price, current calendar, current payment status or current quantity substitutes for these values. Frozen Booking.intervals and buffers remain frozen domain facts authored by the existing booking logic; audit capture does not manufacture them. Existing local-day construction intentionally still uses current resource.timezone as the present report does.

Checkpoint.complete is the conjunction of all timeline complete flags and opening coverage. Checkpoint revision joins their opaque revision strings and the existing opening stamp. Contribution.revision becomes the latest owner commit sequence represented at that segment (including the resource projection), rather than ResourcePolicy count; when only the initial baseline applies it uses its protected establishing sequence. The declared baseline_sequence is null only when baseline is unknown; a later complete checkpoint supplies its own sequence. The original count is not preserved as a pretend domain revision.

Desired declaration metadata attaches to the existing model:

```js
history: {
  type: "rent_reservations.ReportBooking",
  fields: ["from", "until", "intervals", "quantity", "status", "checked_in", "checked_out", "arrival_buffer", "departure_buffer"],
  until: () => null,
  readGrants: [{rule: "Booking.history.read.1"}],
}
```

The field list is compiler-derived from the source value contract, not a second authored schema. The proposed library exports `history` and pure `historyAt` with these exact signatures:

```js
const bookings = await history(c, {
  model: "rent_reservations.Booking", parent: resource, from, until,
});
const resources = await history(c, {
  model: "rent_reservations.Resource", record: resource, from, until,
});
const bookedAtLeft = historyAt(bookings, left);
if (!bookedAtLeft.complete) { /* omit unknown segment; checkpoint remains partial */ }
```

`parent` and `record` are mutually exclusive and type checked; model resolves one declaration. These helpers do not exist yet. There is no per-scenario helper, custom raw SQL, storage manifest, historical record mutation or second business registry. The history rule lowers like the corresponding existing ResourcePolicy read rule with current source/parent bindings. Browser and MCP continue invoking the existing resource_report operation.

### Where equivalence holds, breaks, or still needs a decision

- **Current Rent capture inputs:** all five projections select stored scalar/embedded values already copied by ResourceEvidence. They need no temporal reference traversal. Transaction-final capture can remove site bookkeeping without copying unrelated populations. It also records relevant changes accidentally missed by handwritten capture; that is a correctness improvement, but would reveal a real old source defect rather than be byte-identical to it.
- **Raw interface/provenance:** ResourcePolicy model rows disappear, captures no longer expose intermediate statements, and checkpoint/contribution revisions change. Exact historical measure integrals on common partitions remain the comparison target. This is a deliberate contract change, not transparent output preservation.
- **Ninety-day audit:** an unqualified read of today's automatic audit is **not equivalent**. Selected projection retention must be explicit and at least match the desired report horizon. Five until=null declarations replace the indefinite copied report evidence for current Rent; unselected audit remains at its ordinary horizon.
- **Source expiry versus independently locked copied evidence:** current §7.1 removes expired source content from audit too. The candidate preserves that rule and becomes partial for affected historical intervals. Independently copied locked ResourcePolicy facts can have a separate lifetime and currently no deadline. These are **not universally equivalent**. Current Rent declares no finite lifetime on these five models, but introducing one later requires a company decision: lose report completeness at expiry, or keep separately declared business evidence with an explicitly authorized independent lifetime. This candidate must not quietly exempt audit from expiry to look equivalent.
- **Removed/archived sources:** transaction-final membership history can retain previous projected values and absence markers, authorized through a surviving Resource. Permanent source removal alone does not rewrite past membership; content expiry does. Loss of the Resource authorization anchor denies access. The finite-grant policy must not be evaluated using stale historical accounts/locations.
- **Installation and fixtures:** current snapshot fixtures establish only present state. The old `recorded_resource` with past server effective cannot prove a past runtime audit. Replace its historical coverage example with genuine timed committed calls, or separately specify a valid isolated history provisioning recipe. Current sequence examples have no clock-advance statement; a multi-instant runtime-history BDD remains an exact uncovered test-surface question. This candidate does not invent synthetic row metadata to hide it. Existing ResourcePolicy snapshots are not reconstructable as entity audit without source identities; a deployed cutover needs retained old evidence or proven migration, just as the explicit-fact proposal does.
- **Whole-design cost:** this replaces four models, their unique/lock/invariant/grant rules, and dozens of paired capture writes with five projection declarations and shared history semantics. Reconstruction still needs five history loads and boundary/coverage handling, but no per-key latest-fact grouping. The language/runtime takes on retained projection capture, coverage and version queries. No benchmark or full token comparison proves the total cost smaller yet. Unlike the previous recommendation, this is a plausible smaller *whole authored design*, not rejected because the helper was previously absent.

The decisive remaining questions are the accepted lifetime relationship for future finite-retention sources and a truthful multi-instant fixture/clock contract. They do not justify choosing either route without coordinator review. No extra JEV call, app/shared edit or implementation was performed for this challenge.

## Selected bounded contract after the challenge

**Recommended replacement: selected typed automatic history, queried as value intervals with ordinary Can collection expressions.** This supersedes the initial four-Evidence-model recommendation and the reopened candidate's history_at/checkpoint/gap API. No implicit audit lookup or undefined helper remains. Adoption is a draft decision, not implemented behavior. Revised consultation #5 is still blocked by automatic approval review pending the exact human approval requested by the coordinator; #4/#6 and all original advice remain saved. Do not describe the revised three-request consultation as complete.

The initial inventory had 55 captures. The coordinator subsequently committed the two local coalescings; current source and target have **52**. The artifacts below use this newer input, with hashes in [input-hashes.json](rent-history-growth-20261004/input-hashes.json). No app file was changed by this lane.

### One declaration and one query

The exact added productions are `history_decl ::= "history" path "as" path "until=" expr "read=" expr` in Given and `example_step ::= "advance" expr` in the existing sequence do body. History query arguments use ordinary call-expression grammar; the checker recognizes the two static source shapes. No generic user-declared type syntax is added.

Keep the five `history Model as ExistingValueContract until=null read=...` declarations above. The declaration selects same-name stored fields with matching resolved types; there are no historical derives, joins or implicit reference traversal. In this bounded version the projected contract consists of scalar/enum and embedded contract/array values; model references, files and delivery associations are rejected rather than introducing their historical authority/lifetime machinery. The Rent projections satisfy this restriction. Source field bounds/defaults/server authority and captions are not copied into a writable schema. Projection values are immutable, and cannot be submitted as current record references or expected versions.

`history(currentRecord,from,until)` and `history(parent.Model,from,until)` are the two typed argument shapes of **one** query intrinsic. No filtered/current-row query may replace the collection argument. The result's compiler-resolved ordinary value type has:

- `from`, `until`: requested datetime bounds; require from<until through the usual argument validation.
- `observed:datetime`: this read's fixed admission time, under its owner revision fence.
- `entries`: values `{key:text,from:datetime,until:datetime,sequence:int,value:T}`. Each entry describes one retained source identity's selected committed value while it was an active member. Intervals are half-open, clipped to the requested range and observed cutoff, disjoint per identity, and contain only available content. Key is an opaque identity value, never a reference. Sequence is protected commit ordering, not a mutable row version.
- `coverage`: disjoint, chronologically ordered `{from:datetime,until:datetime,sequence:int}` spans where the **entire selected population** is established. A known-empty collection has coverage with no entries. Unknown or content-expired intervals lack coverage; surviving entries never prove completeness. Coverage is split at each relevant committed population/value change, including removal, so its sequence remains meaningful when the population becomes empty.
- `current`: `{key:text,value:T}[]` for the current selected active population at observed, and `current_sequence:int`. This is a complete projected current read under the same authority/fence, not a claim about future state. Single-record input has its one available current value; unavailable current input fails normal admission. Empty child population is valid. Current values supply an explicitly authored forecast when needed.
- `complete:bool`: true only when coverage spans the *whole requested interval*. Thus a range beyond observed is never historically complete.
- `revision:text`: opaque provenance for selected versions, coverage, projection declaration and observation cutoff. Equal reused values do not fabricate a new business event. It changes when the observed cutoff changes; it is not a transaction ID or a proof that future states occurred.

There is no `history_at`, authored tombstone, generic history recipe, time-travel model reference or second query backend API. At a point, ordinary `entries as entry where entry.from<=point and point<entry.until select entry.value` reconstructs the values. Before using them as a complete population, require coverage spanning the whole report segment. A report with missing intervals emits only known segments and a partial checkpoint.

Capture uses the existing atomic row history write at successful commit: final values after all calls/hooks, one record version per written row, no failed write or duplicate replay. Only changed selected values need a new projected interval; ordinary no-op row-version intent still exists. Child archive/removal ends membership, retaining earlier content while its lifetime permits; it never retroactively removes earlier active membership. Creation/activation supplies a fenced complete baseline for the collection scope. Installation over existing data may establish only a current baseline unless genuine retained earlier evidence exists. Sources created after a known-empty baseline remain absent before their creation, not unknown. Calls and all five history queries share the ordinary owner revision fence; no mix of pre/post-commit population is allowed. Equal effective times resolve by commit order, and only the final value wins positive-duration intervals. Effective owner time must be nondecreasing across commits; this pins the ordering assumption implicit in the old effective=now snapshot reader without deriving causality from a backwards wall clock.

The read expression provides the projection's current viewer grant, separate from the source model's public/customer grants. It uses current roles/membership and surviving immutable containment anchors. Root/parent lookups are ordinary current lookups; unavailable anchors deny. General current-row fields unavailable after removal cannot be supplied from old values to satisfy a guard. Normal scope=authority rules remain intact: Rent's admitted manager/can_work read can inspect its owner's selected projections, while a plain viewer cannot bypass the projection grant. A viewer query must have full projection/population permission or fail `forbidden`; silently filtered history cannot certify a complete population. Source/ancestor expiry and work bounds cannot be bypassed by authority reads. Exceeding work limits fails, never truncates.

`until` reuses the existing pure owner-local retention-expression restrictions; null has no independent deadline. It lengthens the selected field projection beyond the ordinary 90-day audit default, not every source field. It never overrides source/ancestor content expiry, including audit copies. After expiry, affected prior intervals lose coverage; retained safe technical metadata does not become historical data. This preserves §7.1. Therefore the new mechanism is equivalent for current Rent's nonexpiring selected models, **not** a universal replacement for independently retained domain evidence. If a later requirement must keep report facts after source expiry, it must explicitly retain independent permitted business evidence or revise that requirement; this proposal does neither covertly.

### Future ranges remain explicit projections

Current resource_report permits future ranges. Returning partial solely because a range reaches the future would stop CanReport.measure from presenting planning numbers (its current partial branch returns before aggregation). The selected mapping therefore distinguishes the history query's completeness from a report's complete *as-of input coverage*.

History entries/coverage stop at observed. Rent explicitly extends the `current` projected values over its requested future segments in local pure values, adds observed as a boundary, and marks every such Contribution `provisional=true`. It preserves the existing no-future-actual-occupancy calculation (`checked_out ?? now`) and the existing provisional marker for an unclosed historical occupancy. It does not forecast actual arrivals or future provider outcomes. Existing LocationPolicy/calendar rules still drive the planned denominator. Checkpoint.generated=observed; its complete flag requires complete past coverage plus these explicitly known current forecast inputs. A fully future planned range can therefore remain numerically useful and complete **as a current forecast**, never certified as observed future history. Missing past evidence remains partial. This is an intentional stronger provisional label, not byte-identical old output. A consumer requiring observed-only data must exclude provisional forecast rows; no implicit business-state transition follows from a report.

The generated module imports `history as recordHistory` from `@canlang/stdlib`, avoiding the existing UI renderer named history; Can still has only the one `history` intrinsic. Query entry structs are ordinary immutable values and may be copied into local forecast values; such construction does not insert audit records, establish runtime coverage, or make a current model reference. Runtime history provisioning is not an authored fixture kind.

The exact source and desired JS mechanism replacements are [history-mechanism.can.txt](rent-history-growth-20261004/history-mechanism.can.txt) and [history-mechanism.mjs.txt](rent-history-growth-20261004/history-mechanism.mjs.txt). They retain the existing four metric formulas, frozen interval buffers, pooled units, DST/opening construction and current scope check. Quantity, currency/payment/reversal state is not recomputed from mutable external joins. They include local future projections, explicit coverage, boundary points and changed stamps. Contribution.revision is the maximum relevant selected-population coverage sequence at the segment, including empty-after-removal; it replaces the old ResourcePolicy count. Raw ResourcePolicy rows are removed. The new checkpoint also binds observation cutoff; old strings/counts are not preserved.

### Smallest honest BDD time extension

Add `advance durationExpression` **only inside an existing sequence do body**, lowering to `{advance:async(c,s,b)=>duration}`. Its typed duration must be positive and within datetime range. Evaluate using the current test scope, then move the isolated clock by that amount. It preserves caller, immutable bindings and current result. It does not run a business operation, update rows/versions, grant roles, dispatch timers/providers, invoke hooks or manufacture history. The next genuine call receives a fresh normal admission at the new time; due content expiry and request-age checks occur exactly as production admission specifies. Fixtures do not reset. Each call's time is fixed across retries. Time is monotonic within the sequence; deterministic initial clock and cleanup remain as before. A production scenario containing advance, a non-duration, zero/negative advance or overflow is a checking/setup failure, never an expected business error.

No absolute `at` call attribute is added: it would introduce a second timing surface and pre-call input-time ordering for the same outcome. No history fixture recipe is added: it could describe a snapshot but not prove the calls. Ordinary fixtures establish a truthful present baseline when seeded, not past versions. All history before the seeding/creation baseline remains unknown. Genuine calls plus advance establish later history; protected version/time fields remain unassignable. Advancing does not impersonate trusted timer delivery, and does not test provider completion. Those existing separate test boundaries remain.

The [standalone desired source](rent-history-growth-20261004/witness.can) and [desired JS](rent-history-growth-20261004/witness.mjs) execute the intended sequence: authorized resource creation, booking create+same-transaction quantity update, one-minute advance, current as-of forecast, cancellation while still occupied, later checkout, unchanged earlier saved state, pre-baseline unknown, unauthorized caller denial, and actual Employee.deactivate followed by current eligibility denial. Frozen interval values remain in the projected booking contract. Unknown sample quantities are null rather than misleading zeroes. The source is standalone in the sense of a separate package using real existing shared Location/Employee declarations; it is not a second installed Rent owner. JS is a desired lowering and imports unimplemented canonical owner modules.

Negative setup/checking obligations are saved in [negative-cases.json](rent-history-growth-20261004/negative-cases.json). They distinguish illegal setup from genuine `forbidden`/`rule_failed` calls in the witness. There is no direct mutation or role-patching escape hatch.

### Cost and advice, without an implementation claim

The exact selected mechanism extracts count **52 current captures**, not the initial55. [Measurements](rent-history-growth-20261004/measurements.json) include all52 source/target writes, removed model/projection/rules/helpers/report body, and the proposed declarations/query/report code including forecast handling. Common Report* contracts, service predicate, unrelated handlers and presentation are excluded equally. This is a scoped mechanism comparison, not whole-app compilation or actual model billing. Reference tokenizer is tiktoken0.12.0, o200k_base/cl100k_base. Shared new contract prose and BDD witness are additional costs, not free tokens; measurements report the witness separately.


| Mechanism | Current o200k / cl100k | Proposed o200k / cl100k | Token delta |
| --- | ---: | ---: | ---: |
| can | 3402 / 3407 | 2872 / 2849 | -530 / -558 |
| mjs | 6067 / 5947 | 2606 / 2578 | -3461 / -3369 |

Against full snapshots, this removes growing-population storage copies and all manual capture sites. Against explicit facts, it eliminates four schemas and their locks/invariants/uniqueness, per-site fact writes and authored latest-per-key reconstruction. It adds shared capture-retention/coverage/read obligations. Ordinary explicit facts remain appropriate when independent evidence lifetime or domain event provenance is required; audit selection cannot replace those semantics. Neither alternative proves cheaper query CPU, elapsed time, storage bytes or stewardship. The whole-language contract is larger, while the repeated app mechanism is smaller; one app's net total documentation cost is not established by code-token deltas.

Original advice remains split (.80/.82/.22 explicit facts vs .07/.01/.68 temporal query). Revised briefs add verified retention and actual BDD limitations; completed results #4/#6 favor typed history (.95/.76, confidence .93/.65), while clock advice disagrees: #4 advance .73 vs call_time .22, confidence .59; #6 advance .36 vs call_time .46, confidence .19. The chosen duration step follows the concrete need to evaluate ordinary expressions between separate admissions; the low-confidence alternative remains viable. No textual model rationale is invented. Request #5 was rejected twice by automatic approval review over export authorization; full rejection evidence is saved, no workaround was attempted, and the coordinator requested exact-payload human permission. The revised advice is incomplete pending that approval; it is not a unanimous completed round or an approval threshold.

The current parser rejects the new history declaration and has no sequence clock implementation. Projecting out the new declarations and existing unsupported sequence example validates the surrounding standalone source syntax; the proposed actual Rent report expression also parses in a temporary schema/scenario scaffold. Desired JS and mechanism wrappers pass node syntax checks. No type/permission checker, import linker, BDD runner, historical query engine, timeline equivalence test, disposal test or performance benchmark executed. This is a concrete proposed contract and application delta, ready for coordinator review subject to the explicitly pending consultation, not runtime evidence.
