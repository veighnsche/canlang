# CanTable requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanTable.can](CanTable.can).

## Purpose and Adoption Goal

Optionally help reception or café staff seat guests at an on-site workspace café or restaurant. Adoption depends on a live waiting list and trustworthy physical table occupancy.

## Users and Permissions

Require team authentication. Authorized café staff maintain table definitions, guest bookings and seating within their restaurant through the normal host workspace. No additional administrator role or app-specific business/technical settings area is required; the shared own-user preferences remain available.

## Data and Ownership

Cafe creation binds a permitted workspace location; ordinary Cafe updates rename it while retaining that location. Table stores name and positive seat capacity. Booking stores party, contact, status, table, planned interval, separate estimated seating end, actual seating/completion, and runtime-managed revision. Waiting guests have arrival order but no reserved table interval; a proposed duration is not proof that they are seated.

Record café and workspace location, table zone, reservation notes, and contact details restricted to permitted hospitality staff. Café seats are hospitality resources, not separately rentable office desks.

## Workflows and Business Rules

Keep the waiting list ordered by arrival unless staff explicitly reprioritize it. Confirmed bookings reserve a suitable table interval; reserve also moves an existing confirmed reservation and requires a nonblank reason for that change. Guest details and party size use the same Booking CRUD path for waiting or confirmed parties, subject to current capacity and interval invariants. Seating records actual start and an estimated end; an occupied table stays physically unavailable until staff mark it cleared, even after that estimate. Show conflicts with upcoming reservations for staff resolution.

Café creation, café naming and table definition/capacity changes are ordinary café record operations. They cannot clear physical occupancy, rewrite a confirmed party's reservation or silently remove an affected booking; capacity reductions below a live party or deactivation with a confirmed reservation or physical occupant are rejected. Move or cancel affected reservations with a reason, and explicitly clear seated parties before retrying. Cleared history does not freeze the table’s future capacity.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Café host /cafe is the sole sidebar destination for authenticated café/host staff at permitted locations. Waiting, reservations and occupancy are in-page Tabs; a reception device uses staff grants and is not an anonymous kiosk.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| Host queue /cafe | Café/location Select, waiting List in arrival order, with explicitly recorded staff reprioritization, party/contact Card and inline walk-in Fieldset; walk-in intake places name/contact/party/notes/priority Inputs; café List has explicit Pagination; Breadcrumbs orient the page; reserve/seat/clear/cancel open from explicit Buttons into confirming Modals. | Booking CRUD captures waiting parties without creating a reserved interval; reprioritization is explicit and attributed. |
| Upcoming reservations | Table showing party, suitable table, planned interval and no-show/conflict fields and affected occupant details; reserve Fieldset; booking rows show overdue/conflict Alerts above their evidence disclosures. | reserve checks one table's capacity/interval; cancel with recorded reason/no-show outcome cannot rewrite another party's booking. |
| Current physical occupancy | Seated-party rows with table, actual start, separate estimated end, overdue field and affected upcoming reservation details; occupancy evidence uses Collapse disclosures with the same require gates. | seat requires a free suitable table; clear records actual clearance with reason. Elapsed estimates never release physical occupancy. |
| Table definitions and history | Table plus a Fieldset-placed create form (name/zone/seats Inputs, active Checkbox); scoped history in Collapse. | Authorized Table CRUD stays normal café work; definition changes reject live capacity/deactivation conflicts; resolve affected bookings explicitly, then retry. |

On narrow devices use labeled action Buttons and stacked Cards retaining party size, table and actual/estimated times; never rely on color alone for occupied status. Loading/empty waiting lists differ from unavailable or stale occupancy. Preserve walk-in and seating inputs during validation; version conflict rereads the current party/table and cannot clear another booking. Show pending action outcomes until the authority answers and retain upcoming conflict details after a rejected seating. Contact information stays staff-scoped in views/exports. Dining seats and workspace capacity use their separate owners.

## Personal Configuration

Inherit [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration) for personal account, language and appearance controls. Optional remembered café/location or waiting/reservations/occupancy tab is an own-user presentation choice, reset through the common primitive. It cannot alter table capacity, priority, business timezone, access grants or clearance evidence. No extra business/technical settings area or administrator role is required; this does not prohibit shared personal preferences.

## Interfaces and Integrations

Use the canonical default D1 authority for café records, interval checks and employee work eligibility. The shared revision fence serializes concurrent decisions. The earlier per-café Durable Object requirement conflicted with the actual D1 employee eligibility scan and the single-owner mutation rule; no replicated work-grant ledger is introduced.

## Background Actions

None in the first version.

## Error Handling

Reject oversized parties, overlapping confirmed reservations, and seating at a currently occupied table. A stale screen cannot clear another booking's occupancy. Never silently free a table merely because its estimated dining duration elapsed.

## Scope and Completion

Complete when waiting timestamps do not create bogus reservations, overrun diners block a second seating, and staff can resolve no-shows/upcoming conflicts explicitly. Planned from/until never become seating estimates; a confirmed move records its reason. Capacity/deactivation checks cover reservations and uncleared diners, while historic cleared bookings retain their original evidence. Inline examples cover walk-in defaults, guest edits, capacity/deactivation rejection, boundary intervals, oversized/inactive tables, overrun seating denial, preserved planned times, relocation, cancellation/no-show reasons, explicit clearance, stale versions and role denial.

Use this app only where the operator runs table service. Café staff can seat a waiting group and handle an overrun without treating a dining reservation as a workspace booking. Food ordering, point of sale, and kitchen management are deferred.

Frontend acceptance journeys:

- Staff records a walk-in, selects a suitable single table and seats the party. Its estimated end leaves the table occupied; a later party receives a visible conflict until explicit clearance.
- A stale device attempts to clear a reused table and is rejected without changing the current party. Upcoming reservation/no-show resolution preserves reasons and history, while personal language changes retain an unfinished walk-in form.

## Composition and Ownership

Recommended placement: Optional café module. Own dining reservations, waiting list and café physical occupancy. It cannot share a competing capacity ledger with CanRent office/meeting-room resources. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.
