# CanShift requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanShift.can](CanShift.can).

## Purpose and Adoption Goal

Help workspace managers roster reception, community, sales, and facilities staff across locations and arrange replacements. Adoption depends on published shifts with enough recorded coverage and conflict-free swaps.

## Users and Permissions

Schedulers create/edit shifts. Employees manage their own availability, view their assigned work, and request replacement for their own shift. Only the proposed substitute can accept or reject; a removed member cannot be assigned.

## Data and Ownership

One configurable-name Roster exists per team/operator; its count invariant rejects a second independent schedule, so selecting another root cannot bypass employee commitments. Shift records timezone-aware interval, employee, location, and revision. Availability belongs to an employee. A swap snapshots the shift revision and original employee so later scheduling changes invalidate obsolete requests.

Add location, shift role, required skill, draft/published state, and publication revision. Managers configure role coverage targets per location/time window and staff eligibility. Availability includes entered working hours, dated exceptions, and confirmed absence references where connected.

## Workflows and Business Rules

Assign inside declared availability and reject overlapping active shifts. A swap must name another available team member. Acceptance re-checks the current shift and substitute's availability, replaces the assignment, and invalidates competing requests together. Declining a swap leaves the assignment unchanged.

Draft assignments still reserve staff time against competing drafts and published work. Publication makes the roster visible to employees and emits notices; later changes keep prior publication history. Detect uncovered role windows and require an attributed manager override to publish insufficient coverage. Coverage checks the full configured window that intersects the duty, at its initial instant and every duty boundary. Only published eligible duties and the current candidate count; unrelated drafts do not count, and adjacent eligible duties can jointly cover a window. A substitute must satisfy the role/skill as well as time availability. Cross-location consecutive work requires a manager-entered travel buffer on either adjacent commitment; the nearest earlier/later active work determines that check. Availability and unavailable exceptions cover the complete buffered interval; no automatic route optimizer is implied.

Shared host appointments from CanBook count as employee commitments alongside CanField visits. A shift swap/change cannot strand an incompatible dependent appointment. Current employee identity, active status and skill eligibility come from CanOnboard, with unavailable/stale sources surfaced rather than presumed eligible.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Sidebar order is Staff roster /roster for schedulers, then My shifts /roster/mine for active employees. Draft planning and employee published work remain distinct; no new scheduling administration console is needed.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| Staff roster /roster | Location/role/week Select and date Fieldset; chronological Commitment List/Table with employee, skill, draft/publication revision, travel buffer and conflicts. | assign, publish and cancel use the single operator schedule authority; publication gaps require attributed override rather than a hidden bypass. |
| Coverage and dependent commitments | Coverage Table/Fieldset, uncovered-window Alert and scoped host-appointment/service-visit List. | Coverage CRUD and permitted roster changes recheck skills, absence/availability and dependent work; incompatible appointments/visits need owning host/dispatcher resolution. |
| My availability /roster/mine | Own Availability Table and typed Fieldset, including dated exceptions and confirmed absence references when connected. | Own Availability CRUD only; employee can read availability without learning hidden draft assignments. |
| My published duties and swaps | Published Duty Cards with current interval/location/revision; nested Swap List identifies proposed substitute and decision state. | request_swap from the current assignee; accept/decline only by the proposed active, eligible substitute. Acceptance invalidates competing requests atomically. |

Mobile duty Cards keep interval, location, skill and conflict details; chronological lists supply an accessible alternative to calendar grouping. Loading/empty and stale employee/absence sources have distinct states. Unavailable eligibility cannot be presumed available. Show pending publication/change/swap notice delivery separately from the committed roster. Preserve entered assignment and override reason on validation or conflict; refresh current revisions before replacing a shift. Declining keeps the original assignment, and a stale or competing acceptance never appears successful.

## Personal Configuration

Inherit [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Optional scoped preferences remember permitted location/week/role filters or a chronological versus grouped roster view; ordinary validated save/reset persists them without granting scheduling authority. Employee availability and travel buffers are canonical business records, not personal display settings. Preferences cannot change publication state, business timezone, skills, absence decisions or dependent service commitments.

## Interfaces and Integrations

Use D1 for views and a team-scoped Durable Object schedule authority for assignments, availability, swaps, and connected employee service commitments. That authority coordinates both employees' reservations; do not assume a transaction spanning separate employee objects and D1.

Declare absence reads from CanLeave if configured. The schedule authority is operator-scoped across locations so a staff member cannot be independently booked by two sites. When CanField is connected, use the same employee schedule: compatible service visits may occur within their duty shift, but swapping/reassigning/cancelling that shift must reject incompatible dependent visits until a dispatcher resolves them.

A connected reschedule uses `ScheduleV1.stage(value,previous_source,previous_revision)` with a fresh candidate source and revision 1. The owner checks the exact active predecessor, employee/location/kind, current availability/skills and ordinary compatible-duty rules; only that predecessor receives an additional conflict exemption. Both commitments remain allocated until the caller has confirmed all other authorities and releases the old source. Failure/cancellation releases only the candidate. One live candidate per predecessor is permitted. Exact candidate retries validate the whole payload; another request cannot replace its identity.

`release(source,revision)` records a retained release fence even if the candidate has not arrived. A delayed stage/reserve cannot reactivate a cancelled source at that revision. The verified adapter maps declared requests/outcomes to the existing trusted ingress; this source does not implement that bridge or promise atomicity with venue booking.

## Background Actions

Assignment changes commit in the schedule authority when a swap is accepted. Queue publication, material change/cancellation, and swap-request/outcome notices against the current revision; do not email obsolete draft assignments.

## Error Handling

Explain invalid ranges and overlapping shifts. Reject unauthorized swap decisions and conflicting reassignments while preserving the existing shift.

## Scope and Completion

Complete when employees cannot alter another employee's availability, an unavailable substitute cannot accept, and two competing swaps produce one replacement.

A manager can publish a reception rota, see an uncovered window, and arrange an eligible substitute without assigning the same person at another location at the same time.

Frontend acceptance journeys:

- A scheduler sees a reception coverage gap, records a justified publication override and publishes the current revision; employees see published duties but not hidden drafts. A stale employee source prevents an unverified assignment.
- Two substitutes attempt competing swaps: only the designated eligible person can decide each request and one replacement commits. An incompatible connected visit remains explicit for dispatcher resolution while rejected edits preserve the original duty.

## Composition and Ownership

Recommended placement: Staff scheduling. Own published rota and swap workflows at the single operator employee-schedule authority, shared with CanField and host commitments in CanBook. Employee identity comes from CanOnboard; private leave decisions remain in CanLeave. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Draft completion and implementation limits

Publication records an attributed revision and guarded notice intent. Swap requests, acceptance/decline, published reconciliation and cancellation use the same durable notice workflow, with current membership/revision/state checked at dispatch and pending/succeeded/failed/unknown/skipped delivery results retained. Both scheduler and employee views show publication revisions, travel buffers, conflicts, history and their permitted notice outcomes.

Current employee role, skills and location grants are rechecked at assignment/publication/substitution/reconciliation. EmployeeChanged, membership removal and availability create/update handlers flag current or future commitments and invalidate relevant pending swaps; they retain dependent visits, host appointments and interviews for their owning app to resolve. Scheduler reconciliation or cancellation refuses to strand those dependencies. Historical active commitments are outside eligibility-change scans; 500 is a rejecting per-handler work bound, not silent truncation or a promise of unbounded reconciliation. Current authorization denies ineligible work immediately even if an eventual handler needs recovery.

ScheduleV1, CommitmentRequest and the existing retained-predecessor stage/release protocol keep their signatures. Reserve replay validates the entire payload; negative buffers and buffered unavailable exceptions are rejected, and absence acceptance marks conflicting work without deleting it. Reserve/stage ingress still depends on the proposed verified adapter and existing source fences. No new authority, manifest or external scheduling API is implemented.

Inline examples cover one roster per team, publication eligibility, adjacent-window coverage versus a gap, employment/membership invalidation and declined swaps. Their matching JavaScript uses deferred fixture callbacks under the same target contract. Can parsing and Node syntax checks do not execute these workflows or establish distributed correctness. Compilation, stdlib/UI functions, schedule authority coordination, delivery adapters and the BDD runner remain implementation work; all CanShift.mjs imports are proposed contracts.
