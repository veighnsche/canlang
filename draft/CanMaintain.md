# CanMaintain requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanMaintain.can](CanMaintain.can).

## Purpose and Adoption Goal

Help workspace managers move facility faults in offices, meeting rooms, common areas, and equipment through repair and return to service. Adoption depends on a clear owner and preventing unusable spaces from being sold.

## Users and Permissions

Property managers and authorized maintenance staff manage their assigned properties and repairs. Other members do not automatically see tenant contact details. Customer reporters use a verified own-report intake flow; contractors are external contacts unless an explicit report capability is configured.

## Data and Ownership

A facility location references the canonical CanRent location/address and its local maintenance-manager assignment; contractors reference CanPurchase supplier/contact identity in the composed profile. Standalone examples declare one configured local owner where needed. Repairs retain property, reporter contact, description, contractor assignment history, status, completion notes, and decision actor/time. Archiving a property or contractor preserves existing repairs; unfinished repairs require a responsible active manager.

Facility views represent workspace locations through their canonical references. Repairs record affected resource, category, severity, reporter channel, authorized photo versions, priority, target date, repair cost/currency, and open/assigned/in_progress/awaiting_verification/fixed state. Record the associated resource downtime operation and its synchronization status.

Own a non-bookable asset register for HVAC, printers, appliances and safety equipment with location, identifier/serial, category, installed/retired state, warranty/service dates, supplier reference and attached manuals. Link assets located in saleable rooms to the CanRent resource without making each appliance saleable. Inspection plans define asset/area, cadence/calendar rule, eligible assignee, due window, checklist/template version and next due date. Inspection instances retain scheduled date, checklist answers, inspector/time, passed/failed/blocked result and any resulting repair.

## Workflows and Business Rules

Assign only an active contractor. Reassignment records the old and new destination and sends a new assignment notice. Marking fixed requires completion notes; a reported recurrence may reopen the repair without deleting the previous completion. Assignment does not itself prove contractor acceptance.

A report does not automatically remove a resource from sale. An authorized manager requests a timed or indefinite out-of-service block at the CanRent availability authority; new incompatible reservations then fail. Existing affected bookings enter a staff relocation/cancellation review queue and are never silently erased. A technician's completion awaits manager verification before the resource is released for sale. Failed or uncertain integration remains visible and recoverable.

Generate one inspection instance per plan/due occurrence; repeated scheduling cannot create another. Freeze the applicable checklist when dispatched. Failed or blocked inspections require recorded evidence and a linked corrective repair/action; passing a routine check cannot independently clear an open repair downtime block. Retiring an asset stops future planned instances while preserving existing inspection/repair/warranty history. Overdue checks remain visible for manager action rather than becoming presumed passed.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Order navigation as My facility reports, then Facilities for granted managers/technicians. Asset, inspection and repair details are contextual; inspections and verification queues sit within Facilities. Location/supplier selection uses canonical owners; no copied directory or additional administration console.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| My facility reports — verified own index | Fault-report Fieldset with description/photo, repair status Badge and own-history Table | Submit a verified report and read its outcome without browsing the full location queue |
| Facilities — staff index | Location/resource/severity/status Select filters and asset/warranty Table; repair Cards and location-scoped servicing/export Button | Maintain permitted assets/plans/repairs and select active suppliers through canonical records; exports exclude unrelated customer contacts |
| Inspection work — staff queue | Upcoming/overdue and failed/blocked Tabs; frozen checklist Fieldset, answers, inspector/time, result Badge and linked repair history | Capture an attributable result through the inspection workflow; blocked/failed results retain evidence and corrective action |
| Repair verification — contextual queue/detail | Assignment history, authorized photos, completion notes, downtime synchronization Alert and affected-booking review links | Assign/reassign, request downtime, finish, verify/release and reopen through owning actions; technician completion cannot independently restore saleability |

On phones, show due work, checklist items and permitted next action before secondary asset history. Distinguish loading, no own reports, no due inspections and filtered-empty. Preserve unsaved report/checklist/verification evidence after validation or stale actions; optional upload failure remains visible without erasing saved text. Pending/failed/unknown downtime and assignment-notice delivery appear separately from repair state. A superseded contractor loses obsolete actions and queued disclosure; affected customers remain in relocation/cancellation review rather than disappearing. Passing an inspection cannot clear another open repair block. Retirement stops eligible future inspection work while existing inspection, repair and warranty history stays readable under policy. Return-to-service reflects confirmed owning authority, not optimistic local availability.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. A reporter may remember own open reports; maintenance staff may save an authorized location, severity/status filter and inspections-versus-repairs starting view. Show clear/reset and revalidate saved scopes. Preferences cannot assign contractors, change cadence/checklists, declare a check passed or set room saleability. Those controls remain ordinary protected facilities workflows; provider wiring, delivery policy and integrations are excluded from personal settings.

## Interfaces and Integrations

Use D1 for records and EmailService for contractor assignment messages.

Use R2 for bounded repair photos. Declare CanRent downtime/release and affected-booking lookup capabilities and optional CanField service-job handoff. Do not create an independent room availability state that can contradict the booking authority.

Use CanPurchase supplier identities, CanField inspection/repair visit scheduling, and CanRent downtime references. CanDo may show pending inspections but records completion only through the inspection workflow. Asset data cannot become another writable copy of the CanRent room or CanStock quantity ledger.

## Background Actions

Send the assignment email when a repair becomes assigned. Assignment delivery remains distinct from inspection generation and reminder work.

Use one keyed PlanDue schedule per plan, carrying its revision and due date. Each admitted occurrence generates at most one due instance and advances the cadence, then schedules its next occurrence; overdue catch-up remains explicit work, never a presumed pass. Schedule revision-bound assignee reminders at 09:00 in the location timezone. Re-read plan/asset active state and current assignment before generating or notifying. A recurring plan edit cancels/replaces only eligible future work with attribution; old completed evidence remains frozen.

## Error Handling

Explain inactive/missing assignees and failed delivery. Persist assignment changes before mail; stale queued notices must not disclose a repair to a superseded contractor. Keep reopened repair history visible.

## Scope and Completion

Complete when authorized staff can assign, reassign, finish, and reopen a repair while retaining who did what and preventing stale contractor mail.

A broken meeting-room air conditioner can be reported, taken out of sale, dispatched for repair, verified, and returned to sale while affected customers remain visible for resolution.

A scheduled HVAC inspection produces one attributable result, a failed check opens a linked repair and configured downtime, and a verified repair restores saleability without deleting the inspection history.

Frontend journey: a customer reports a room fault and sees only their own status; a manager opens the location queue, requests downtime and sees pending confirmation plus affected-booking review links.

Frontend journey: a technician submits a failed frozen checklist with evidence, creating linked corrective work. Repair completion awaits manager verification, confirmed release restores availability, and reopening preserves the earlier inspection/completion and assignment history.

## Composition and Ownership

Recommended placement: Facilities. Own asset register, inspection plans, repairs and manager verification. Compose with CanField and CanStock. CanRent remains the owner of resource downtime and CanPurchase owns suppliers and orders. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

### Owned work and downtime routing

Technicians have a location-scoped name-only Plan grant so the Facilities plan list can reach their own Inspection rows. Assignment email and plan editing remain manager-authorized; the Inspection grant continues to require the exact inspector and current location work eligibility.

The exported `work` and `work_detail` reads disclose only the current technician's pending, location-authorized inspections and the canonical `inspect` action. The delegated form keeps the frozen checklist and input signature owned by that operation; CanDo does not complete a copied task. Detail and invocation recheck eligibility. Completed inspection evidence remains available through the normal source policy.

A downtime request freezes `Repair.block_resource` with its operation source. Restoration routes to that same resource even if the asset's current resource link changes. It can release only this repair's own block. Transport completion must match the stored delivery and business source before changing the displayed synchronization state.

Verified team members can select nonretired assets through a limited name/identifier/location grant solely for own-report intake. Supplier, warranty, manuals and repair records retain their existing staff grants. Field report events retain attributable immutable source evidence and mark the linked repair for review; an assigned/in-progress repair moves to awaiting verification. A later correction to an already fixed repair raises review without automatically reopening it or altering room availability.

### Authored workflow completion

Active plan creation and edits verify the assignee’s current technician role and location work grant. Inactive historical configuration remains valid after role or employment revocation; current grants govern active admission, generation, reminders and inspection use. Managers supply an explicit reminder email. Plan create/update hooks replace the keyed due occurrence and capture the asset’s current inspection epoch; an update increments the template revision. Retirement increments that epoch immediately, so reinstatement requires an explicit authorized plan edit before old recurring schedules can resume. Dispatched instances freeze their asset epoch alongside checklist, due date, template revision and inspector.

Every plan edit or asset retirement retains one owner-local Cancellation with immutable scope, prior revision/epoch, due-date cutoff, reason, author and time. Current inspection admission and work projections consult all retained boundaries immediately: matching future pending work is unusable even before physical cleanup. Today’s, overdue and completed instances retain their frozen evidence. Later edits, a later date and reinstatement do not erase an earlier boundary. The cancellation continuation reads current state, deactivates one matching old-epoch plan or cancels one matching still-pending future inspection, then commits its cursor and emits the next identity event. A newly configured epoch is excluded from an older retirement continuation, including its current keyed schedule. Completed/previously cancelled inspection rows are not rewritten. Generation treats immediately superseded pending instances as replaced even while their physical cancellation is pending, without duplicating a completed instance for the same due date. Cancellation attribution comes from its retained business change rather than the background handler’s null actor; once physically cancelled, that decision and its attribution are locked.

Facilities shows each Cancellation’s phase and attribution. An authorized, location-scoped manager can resume a pending record through the canonical action; this queues continuation without claiming cleanup completion. An empty current scan advances plans→inspections→complete. Retained completed boundaries continue to guard old work. Each mutation has a fixed number of local effects independent of inventory size; no 100-record cancellation cap remains. For 99, 100, 101 or 1000 old plans and eligible instances, admission still writes only its own record and one Cancellation. Retirement cleanup uses one transaction per old plan and one per eligible instance, plus phase transitions; an edit scans only matching instances. These are manual progress traces, conditional on delivered continuations or authorized recovery, not executed runtime tests. Per-call checklist/input/result bounds and independent availability reconciliation remain ordinary finite local constraints.

Reminder admission and mail dispatch recheck due time, frozen revision/epoch, current assignment, employment/location eligibility, plan activity, retirement and retained supersession. `reminded_at` records enqueueing, not provider delivery. Retirement stops future generation immediately and cancels matching keyed schedules/reminders through the owner continuation; history remains authorized and visible.

Each successful verification retains a locked Verification containing the submitted technician completion, actual manager evidence, author and time, including repairs with no room block. Reopening and another repair cycle retain both verification records; later completion cannot overwrite the earlier decision. Staff history shows these records under the repair, while own-report access keeps its existing limited fields. The authored canonical journey uses an ordinary named reporter and scoped manager/technician accounts to report, assign, start, finish, verify, reopen and repeat repair/verification with two preserved decisions.

Each contractor assignment retains its frozen destination, body, reason and author. Each Notice row stores the protected `delivery(Mail.send)` association and derives `state` from its receipt status, replacing the stored delivery ID and status mirror; succeeded keeps the existing Delivered caption and never claims contractor acceptance. The pure receipt-copy callback is removed with no business transition lost. A definitely failed attempt can be retried only while that assignment is current and no pending, unknown or successful attempt exists. Dispatch checks the exact assignment identity, so reassigning even to the same supplier supersedes the old queued notice. Explicit technician start records `in_progress`; mail delivery never claims contractor acceptance.

Availability recovery reuses the original block source, resource, interval or release evidence through the real RoomsV1 contract. Completion handlers correlate the current delivery and action; verified newer Rooms.changed outcomes reconcile lost responses. Owner-confirmed release is separate from a manager's local fixed decision. Reopening waits for unresolved release to settle and preserves prior completion/history. RoomsV1's idempotent owner handlers and restoration fence preserve these semantics across reordered downtime/release deliveries.

Own report intake requires the caller’s verified email admission fact, and the own-report index explicitly filters by that reporter even for staff with broader grants. The limited grant includes only the safe reporter identity needed by that filter.

The affected-booking lookup retains a correlated, timestamped RoomsV1.AffectedBookings snapshot with booking/version/interval/status and conflict references, without copied customer contacts. Refresh failure/uncertainty is displayed alongside any prior snapshot; no partial or stale snapshot is asserted to resolve the owning CanRent review queue. Contextual forms invoke the exported canonical field.dispatch with the repair/inspection and location bound; remaining dispatch inputs, role checks and schedule ownership stay in CanField.

The handwritten JavaScript target follows DESIGN §13: canonical exported identities, one canApp registry, direct role checks, normalized CRUD admission callbacks, current-context queries, numbered grants/invariants/locks, proposed shared UI factories, contextual fixture recipes and JavaScript observation callbacks. Checks performed are supported source/table syntax and JavaScript syntax plus source/target metadata review. The current parser rejects the canonical `delivery(Mail.send)` field type and the structured enum label on the model derive; a disclosed temporary projection replacing only that type with `text` and that label with its scalar caption, combined with the table-only sequence projection, parses the remaining source and tables, checking surrounding syntax only, not receipt typing or label rendering. All five status values retain explicit English/Dutch labels in the actual source. `node --check draft/CanMaintain.mjs` passed. Three attached `examples`/`do` sequences show genuine separate Plan/Asset/Inspection/recovery calls with fixed named callers, stale-version rejection, immediate future-work denial, reinstatement and frozen completed history. Sequences remain outside the initial parser; a temporary table-only projection checks the supported syntax and does not establish sequence acceptance. Inline BDD cases are authored review artifacts; no compiler, runtime, renderer, adapter or BDD runner has been implemented or executed by this work.


### Support handoff interface

`Asset` and the existing authenticated `report` are exported; `report` explicitly returns its created `Repair`. CanDesk invokes this same operation with its unchanged caller identity and retains the result on the original Ticket. Verification, active-asset and nonempty-content admission checks and all Asset/Repair read grants remain intact. This gives support staff the existing limited own-report view, never maintenance-manager powers or repair access for the ticket's customer. The source examples and narrow proposed JavaScript target mirror the returned repair; syntax checks do not execute this workflow.
