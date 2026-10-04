# CanBook requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanBook.can](CanBook.can).

## Purpose and Adoption Goal

Help prospective and existing workspace customers book site tours, sales consultations, and onboarding appointments. Adoption depends on self-service appointments that respect the host's availability.

## Users and Permissions

Require team authentication. Members manage calendars and appointments within their team.

Authorized hosts manage their own or assigned location calendars. Verified customer accounts can book, view, cancel, and request rescheduling of their own appointments; they never gain staff team membership.

## Data and Ownership

Calendar stores team, timezone, default duration, weekly opening hours, and dated availability exceptions. Appointment snapshots its chosen duration and start/end, customer/email, status, and revision. A later default-duration change must not move existing appointments.

Add location, appointment type, host, customer organization/contact, meeting instructions, cancellation cutoff, and attended/no_show outcome. Appointment types define duration and any required meeting-space reference.

## Workflows and Business Rules

Book only inside calendar availability and in a non-empty time range. Timed intervals are half-open so adjacent bookings are allowed. Confirmation must follow the reservation authority's decision; simultaneous requests for the last slot yield one booking. Cancellation releases capacity; rescheduling preserves the original slot until the move succeeds.

Only publish bookable host slots within location hours and host availability. Support staff-created appointments and customer self-service. An appointment needing a scarce room must obtain that room's reservation from the same authority used by CanRent; a host booking alone cannot guarantee it. A failed multi-resource confirmation remains pending and releases provisional holds through recoverable compensation.

When hosts also work published shifts or service visits, reserve the host commitment at the same operator employee-schedule authority; compatible appointments may fit inside the host's assigned duty, but not overlap another appointment/service visit, incompatible shift, absence or travel buffer. The room hold remains a separate recoverable CanRent operation.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Declared sidebar pages are Appointments (`/appointments`) for public availability and verified own appointments, then Host calendars (`/appointments/hosts`) for authorized hosts. Booking and appointment details are contextual views. Use daisyUI; public discovery exposes no other customer's details.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Location/type availability | Location/type Select controls, instruction Card, local timezone Badge and date-grouped available-slot Lists. | Display only published slots inside location hours and host availability; a displayed slot is not a reservation guarantee. |
| Booking confirmation | Fieldset for permitted customer/contact details, selected host/type/time/duration summary and cancellation-cutoff Alert; confirmation Button. | Book through the existing reservation authority. Any required room and employee-schedule commitment must return their own outcomes before confirmation. |
| Own appointments/history | Upcoming/past Tabs with appointment Cards showing local start/end, instructions, status, cutoff and attendance; cancel/reschedule controls. | Verified customers act only on their own appointments; rescheduling retains the original slot until the move succeeds. |
| Host calendars | Calendar configuration Fieldsets for timezone, durations, hours and dated exceptions; day/week Tabs with an editable appointment-calendar layout and chronological Lists and attendance controls. | Authorized hosts maintain assigned calendars, create staff appointments and record attended/no_show under the existing operations. |

A pending multi-resource booking shows recoverable hold/confirmation state, distinct from confirmed attendance. A conflict retains entered details and explains the now-unavailable slot; rescheduling failure keeps the original appointment visible. Show empty available days and empty customer history without fabricated availability. Surface reminder delivery failure separately from reservation state; bookings inside the reminder window show their confirmation outcome. Preserve unsaved host availability edits after errors and confirm discard on navigation. On mobile stack slot Lists and confirmation fields, keeping timezone and cutoff immediately beside the chosen time. Default-duration changes leave existing appointment summaries intact.

## Personal Configuration

Inherit the shared own-user dialog and base settings. Remember a user's preferred day/week presentation and appointment-history filter. Locale-aware date/time formatting keeps the authoritative calendar timezone visible; presentation preferences never alter availability, cutoffs, host commitments or reminder scheduling. No extra admin/settings area is required.

## Interfaces and Integrations

Use D1 for records, Durable Objects for reservation coordination, and EmailService for customer reminders.

Declare any required workspace reservation capability and customer/lead reference link. CanBook owns appointments; CanRent owns paid workspace reservations.

## Background Actions

Send a reminder one hour before the appointment using its current revision. Bookings made inside that reminder window receive one confirmation instead of a reminder scheduled in the past. Cancellation or movement invalidates older scheduled work.

## Error Handling

Explain invalid durations, invalid time ranges, and booking conflicts without replacing an existing reservation. Show reminder-delivery failures.

## Scope and Completion

Complete when working hours and timezone are respected, a duration change leaves existing bookings intact, competing requests cannot double-book, and cancellation/rescheduling updates reminders.

A prospect can book and cancel a tour, the host can record attendance/no-show, and a room-backed consultation cannot collide with a paid room booking.

Frontend completion additionally requires these journeys:

- A prospect chooses a local-time tour slot, confirms it, finds the cancellation cutoff and cancels their own appointment; the host sees released capacity and the current reminder state.
- A room-backed consultation competing for scarce room/host availability shows a conflict or pending outcome without a false confirmation; a failed customer reschedule leaves the original slot intact.

## Composition and Ownership

Recommended placement: Customer and sales. Own appointments and host-calendar configuration; reference CanCustomer contacts and the shared employee schedule where hosts also serve roster/service duties. CanRent owns required room reservations. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.


The appointment owner exports Calendar, Window, Type and Appointment plus the canonical book/reschedule/cancel/attendance operations for contextual consumers such as CRM. Exporting provides visibility and enabled model CRUD identities, without assigning host authority or widening record reads. Booking retains `by=authenticated`, active calendar/host, future time, matching customer/contact, verified own contact or authorized host-manager work scope, and a containing published window. CRM stores the resulting readable appointment's exact reference after its authorized page reread; a pending record never proves host/room confirmation. The existing host_calendar/tour/booked fixtures are exported only for inline examples, not production interfaces.

## Authored draft workflow

Calendar WeeklyHours and ClosedDay combine with positive and negative dated Window records and the canonical location `is_open` predicate. Display-only `hours` text never authorizes a booking. Local conversion uses the authored timezone and fold choice; host hours, location hours, holidays and published availability must all permit the requested interval. The location owner separately supports overnight opening intervals and dated overrides. CanBook currently publishes same-local-day host appointments.

Every initial booking or movement has an Attempt with a fresh stable source and immutable interval. Reschedule calls the owning employee `stage` and room `stage` operations with the exact active predecessor source/revisions. Both retain the original allocation while the replacement is pending. The employee authority preserves its existing compatible-duty exception; staging exempts only the predecessor from additional appointment conflicts. CanRent uses a noncommercial VenueReservation in the same capacity ledger as paid bookings. Its provisional outcome is `pending`; only its committed confirm result is `confirmed`. Appointment confirmation waits for both authorities, then adopts the candidate and retires the predecessor for release. A failed candidate leaves the original appointment and reminder intact. The room account and resource remain frozen when another authorized host manager reschedules.

Cancellation and failed movement enter recoverable cleanup. Releases use the recorded host source/revision and explicit frozen venue resource, including cancellation before delayed allocation arrives. Provider tombstones prevent late allocation; late callbacks cannot revive a cancelled attempt. An uncertain pending movement can be discarded while preserving the original confirmed appointment, then its candidate is cleaned up. Failed or uncertain cleanup stays visible and can be retried through the owning operation. Confirmation/reminder Notice records show transport outcomes separately from appointment state. Movement/cancellation invalidates the old reminder, and a booking inside the reminder window receives its confirmation without scheduling a past reminder.

Inline examples cover holiday exclusion, authenticated booking, failed staged movement preserving the original, adoption only after both outcomes, unchanged-time rejection and cancellation. These are authored expectations, not executed scenario evidence. Focused source parsing checks syntax only. No generated CanBook JavaScript, runtime, reservation adapter or email implementation is supplied.

The difficult staged-replacement decision and its three rewritten JEV consultations are saved in [crm-connections-reschedule-20261004](../design/jev/crm-connections-reschedule-20261004/README.md). Their probability distributions are advice; independent source inspection established why the original same-source replacement could lose the predecessor before the other authority settled. Cross-provider atomicity is not claimed.
