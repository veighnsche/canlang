# CanField requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanField.can](CanField.can).

## Purpose and Adoption Goal

Help the workspace operator dispatch technicians, cleaners, and setup staff for on-site service visits. Adoption depends on a practical daily schedule and attributable completion reports.

## Users and Permissions

Dispatchers manage customer records and scheduling. Technicians see their assigned jobs and create their reports; only the assigned technician advances work, unless a dispatcher makes a recorded correction.

## Data and Ownership

The customer reference supplies authorized name, contact and address from the configured customer owner. Job snapshots the visit address and dispatch instructions as well as customer, technician, interval, revision, and planned/in_progress/done/cancelled state. Reports retain author/time and optional authorized photo references. Editing the customer address does not move an already dispatched job.

Jobs record location, resource/repair reference, service type, priority, required skill, and scheduled service window. Technician availability includes working hours and dated exceptions; dispatchers maintain the skill eligibility used for assignment.

In the composed facilities profile customer/supplier/location/resource and employee identities reference their canonical owners. Keep the dispatched address/instruction snapshot here; a local Customer record is not a second editable customer directory.

## Workflows and Business Rules

Confirm technician availability before dispatch and when rescheduling; where technicians also appear in CanShift, use its shared authoritative employee schedule. A visit may fit inside an eligible duty shift, but may not overlap another service visit, incompatible shift, travel buffer, or accepted absence. A local job calendar alone cannot confirm it. Cancellation releases scheduled capacity; completion releases unused remaining time. Reassignment invalidates the old technician's action permission. Completed reports remain attributable and cannot be silently overwritten.

Check declared working availability and skill eligibility as well as existing reservations. Staff enter travel/setup buffers where required; there is no inferred travel-time optimization. Record a blocked visit with reason and follow-up action rather than falsely marking the job done.

Inspection visits return their attributed checklist/report result to CanMaintain. A completed visit cannot certify a passing inspection or release repair downtime unless the owning verification workflow accepts the evidence.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Derive sidebar order as Service dispatch, then My visits, showing each destination only to its permitted audience. Blocked work is a queue within dispatch; reports open from their job and are not global navigation entries. Customer selection/creation uses its authorized owner.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| Service dispatch — dispatcher index | Select filters for location, skill and status; date-grouped job List and Card agenda showing technician, interval, address snapshot, instructions and status Badge. Inline intake controls; the dated agenda gains an empty state; the visit drawer shows a state badge, gated blocker alert, pending-confirmation skeleton placeholder and reassign/cancel/discard/correct dialogs. | Dispatch, reassign and cancel through the owning operations after availability, skill and schedule checks; preserve entered travel/setup buffers |
| Blocked jobs — dispatch queue | Table of blocked reasons, follow-up work and linked repair; Alert for scheduling conflicts or unavailable authority. The blocked queue stays within dispatch; the scheduling-conflict alert maps to the gated blocker alert + pending skeleton (pending never looks planned). | Recorded dispatcher resolution and reassignment; blocking never counts as completion |
| My visits — assigned technician index | Compact Cards ordered by visit time, readable address/instructions, state Badge and report Fieldset with notes and optional photo. The compact list becomes a state-grouped `board` with an address/state `indicator`; start/block/complete keep canonical ops via action + dialogs; report correction stays contextual. | Start, block and complete only the current assignment; an inspection result returns to its owning verification workflow |
| Job report — contextual detail | Attributed report List, photo state, repair link and shared-toolbar report export. Report tables gain empty states and correction dialogs with notes + optional photo. | Authorized report entry/download; completed evidence cannot be silently overwritten |

On a phone, put address, interval and the next permitted action before secondary report history. Preserve unsaved notes during shell changes and failed submissions. Show separate loading, no assigned jobs and no filter matches states. Pending schedule confirmation cannot look planned; stale reassignment removes the obsolete action and explains the conflict. Failed photo upload retains entered notes with a missing-photo Alert; retry or explicitly submit without the optional photo. Only a successful canonical completion creates the report and completes the job. Completion notice delivery is distinct from the recorded report and releases only appropriate remaining capacity.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. A user may save an authorized default location, an own-visits versus dispatch starting view, and permitted status/skill filters; reset restores the ordinary unfiltered accessible view. State-filter memory is editable in context. Recheck saved choices against current grants. These preferences cannot set working availability, skill eligibility, assignment, travel buffers or schedule authority. Dispatch/reporting remain ordinary workflows; exclude provider/scheduling configuration.

## Interfaces and Integrations

Use D1 for records, R2 for photos, Durable Objects for scheduling reservations, and EmailService for completion messages.

Declare repair assignment/completion linkage to CanMaintain and any resource downtime capability from CanRent. Booking a technician does not itself remove a room from sale.

## Background Actions

Send customer email when a job becomes done.

## Error Handling

Reject stale status changes after reassignment and conflicting dispatches. Failed optional photo upload may leave a saved notes-only report, clearly marked without the photo. Repeated completion must not send a new logical completion notification.

## Scope and Completion

Complete when a reassigned technician loses access, a cancelled/completed job releases the appropriate reservation, and the visit address/report stay stable after customer edits.

A dispatcher can assign a qualified technician to an air-conditioning fault, block the visit when access fails, then retain the final visit report against the repair.

Frontend journey: a dispatcher filters a location, enters a qualified visit and sees pending schedule confirmation; a conflict preserves the form and explains why no visit was confirmed.

Frontend journey: on a phone, the assigned technician records blocked access, then a failed optional photo upload retains entered notes. They retry or explicitly complete without the photo; only the successful operation creates the report/completed outcome. After reassignment, an old open screen cannot complete the job and refreshes its authorized actions.

## Composition and Ownership

Recommended placement: Facilities. Own scheduled visits and attributable service reports linked to CanMaintain repairs/inspections. Use the shared employee schedule and original location/resource/supplier references; visit completion returns a repair for verification, not automatic resale. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

### Reservation replacement and report handoff

Reassignment stages a fresh source against the exact retained predecessor. It confirms the candidate before changing the current employee/time; failure or discard releases only the candidate. Success atomically updates the local assignment and retains a durable cleanup request for the previous staffing commitment. Cancellation and completion use the stored staffing revision, never the unrelated mutable Job version. Delayed callbacks cannot revive a cancelled job or apply a candidate over a changed assignment. Unknown staging can be discarded with a fenced cleanup while the original remains usable. Failed cleanup is visible and retryable.

Completed reports are immutable, linked corrections append evidence, and `ReportSubmitted` returns the report to the owning repair. CanMaintain marks it for review; neither a visit completion nor correction restores a resource or certifies an inspection. The shared staffing stage allows a different eligible employee at the same location/kind, checking the new employee's actual availability while retaining the original commitment.

Inspection visits bind the canonical `Inspection` as well as optional `Repair`. Dispatch requires its pending state, location and selected inspector. Completion invokes the imported owning `inspect` operation with the exact checklist answers/result and report evidence in the same transaction; its existing maintenance-technician permission and rules remain required. A generic visit report cannot substitute for that outcome. Reassigning an inspection visit first requires the source inspector assignment to agree; no field-service operation impersonates another inspector.

Verified staffing changed events resolve unknown initial/replacement outcomes by exact source and revision, rechecking current employee scope/skill and pending inspection assignment. They do not revive cancelled/completed jobs or overwrite changed assignments. Confirmed releases also reconcile outstanding cleanup. A later unavailable commitment blocks active work visibly; release evidence remains distinct from a visit report. Duplicate locks were removed without changing the protected fields.

Cleanup selects one unreleased replacement and one finished visit per owner tick, records their delivery identities, and therefore advances past submitted work without a global match-count cutoff. Failed or uncertain deliveries remain visible for the existing scoped retry; no release is inferred from dispatch. This is bounded progress, not `for limit=100` pagination.
