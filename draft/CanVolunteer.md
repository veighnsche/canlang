# CanVolunteer requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanVolunteer.can](CanVolunteer.can).

## Purpose and Adoption Goal

Optionally help workspace community teams organize member volunteers for mentoring sessions, community events, and charity activities. Adoption depends on clear signup capacity and participants knowing their own assignments.

## Users and Permissions

Organizers manage opportunities and assignments. Public visitors discover open opportunities within the selected team. Authenticated volunteers manage their own signup and complete their own assigned tasks; the assignments tab requires authentication without requiring operator-team membership. Organizers see their organization's attendance; volunteer contact details and tasks are not a public roster.

## Data and Ownership

Opportunities have a title; assignments store task text and belong to a volunteer's signup. Opportunity stores timezone, interval, capacity, and open/cancelled state. Signup is unique per volunteer/opportunity and retains registration/confirmation/withdrawal history. Task completion records its volunteer/coordinator actor and time.

Record sponsoring location, organizer contact, activity description, volunteer requirements, attendance outcome, and any confirmed venue reservation reference. Volunteers are customer/community accounts, not automatically operator employees.

## Workflows and Business Rules

Registering deliberately reserves a place; withdrawal releases it once. Prevent duplicate or overlapping active signups within the organization. Organizers confirm volunteers and can cancel an opportunity, releasing its places and invalidating its tasks/reminders while retaining history.

Organizers record attended/no_show after the activity while preserving prior confirmation. A reschedule re-checks volunteer conflicts and capacity and requires affected volunteers to reconfirm if their availability changed. If a rentable venue is required, confirm it through CanRent before publishing; volunteer capacity does not reserve a room.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Sidebar order is Volunteer activities /volunteering, then Volunteer coordination /volunteering/work for organizers. Own signup/task history stays local; volunteers are community customers rather than employee roster members, and no additional administration console is needed.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| Activity discovery /volunteering | Location/date/type filters and Opportunity Cards showing instructions, requirements, timezone/interval, current places and venue outcome. | signup reserves one place after capacity/conflict checks; only published eligible opportunities appear and venue capacity remains CanRent-owned. |
| Own signups and tasks | Own Signup List with registered/confirmed/withdrawn and attendance Badge; Task Cards show instructions, completion actor/time and result Alert. | withdraw releases once; complete requires the current own confirmed assignment, without exposing other volunteers' contacts/tasks. |
| Volunteer coordination /volunteering/work | Opportunity Fieldset/List, publication and cancellation status, capacity/venue conflict Alert and scoped participant Table. | Opportunity CRUD, publish/cancel follow organizer location grants; venue fulfillment precedes publication when required. |
| Assignments, attendance and history | Signup/Task Tables and typed task Fieldset, reconfirmation needs and notice delivery state; history in Collapse. | confirm, attendance and Task CRUD use organizer scope; recorded attended/no_show is distinct from confirmation. Rescheduling rechecks conflicts/capacity and affected volunteer agreement. |

Mobile Cards retain interval/timezone, remaining capacity, own state and instructions. Loading, full, empty and unavailable venue/eligibility states are separate. Keep signup or task input on validation/conflict and show the authoritative outcome, not optimistically claimed capacity. Pending/failed notification remains separate from committed registration/withdrawal. Cancellation invalidates tasks/reminders, retaining history; stale screens cannot revive a cancelled activity. Organizer participant information stays private, including exports; volunteering never satisfies employee role/skill coverage.

## Personal Configuration

Inherit [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration) for persistent validated language/appearance and account/security controls. Preferences remember authorized location/date/type filters and discovery versus own-assignment view, reset through the shared own-user action. They do not register attendance, reserve a place/venue, change business timezone or confer organizer/staff authority. Activity requirements and notification scheduling remain canonical business behavior; integration setup stays outside personal configuration.

## Interfaces and Integrations

Use D1 for records, Durable Objects for signup capacity, and EmailService for volunteer reminders.

Declare venue booking or event linkage when configured. Volunteering does not satisfy paid employee roster coverage or bypass staff role/skill requirements.

## Background Actions

Remind confirmed volunteers one day before start using current opportunity state. Notify affected volunteers when their confirmed opportunity is cancelled or materially rescheduled; do not send stale reminders.

## Error Handling

Explain full opportunities and invalid ranges or volunteer references. Withdrawal must remove the reservation and pending reminder; expose notification failures.

## Scope and Completion

Complete when volunteers can actually sign up and use their tasks, duplicate signup cannot take two places, and withdrawal/cancellation releases capacity without leaking the roster.

Use this app only if such activities exist. Members can sign up to mentor at a community session, receive tasks, and have attendance recorded without becoming staff or overbooking its venue.

Frontend acceptance journeys:

- Two volunteers request the last place: one reservation wins and duplicate signup consumes no second place. The participant reads private task instructions, receives an explicit completion result and can withdraw with capacity/reminder release once.
- An organizer cancels or materially reschedules an activity: affected volunteers see cancellation or reconfirmation needs, stale reminders do not send, and venue conflicts remain visible. Attendance is recorded separately without exposing a public roster or implying staff coverage.

## Composition and Ownership

Recommended placement: Optional community volunteering. Own volunteer signup capacity, attendance and tasks. CanRent owns rentable venues; source assignments may appear in CanDo without becoming employee roster shifts. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Current authored draft contract

The draft reuses a withdrawn signup on reactivation, retaining its unique identity/history and reserving only one place; the authenticated caller's canonical actor.email remains the destination convention. A material reschedule rechecks capacity/conflicts and an entitled venue, cancels old reminders, retains places and requires volunteer consent before organizer reconfirmation. Completed tasks and attendance history remain distinct.

Venue is an optional actual CanRent Booking reference, never a caller-set confirmation boolean. Publishing/linking/rescheduling checks current confirmed/occupied entitlement, paid/free/on_account payment, consumed/not-required allowance and complete interval/location coverage. The caller still needs the owner's booking read grant. The exported verified ReservationChanged occurrence closes an invalid venue-dependent activity and invalidates confirmations/reminders with revision-guarded notices. This is explicit event consumption, not atomic reservation across owners; its runtime delivery and current-reference rechecks remain unimplemented. Public availability is a bounded authority aggregate without participant grants; work/work_detail returns only current own eligible tasks. Nonmaterial activity edits and explicit publish/link writes replace reminders using the correct committed enclosing version.
