# CanContract requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanContract.can](CanContract.can).

## Purpose and Adoption Goal

Help workspace managers track customer occupancy agreements, property agreements, and supplier contracts with their obligations and notice dates. Adoption depends on retrieving executed terms and acting before a renewal deadline.

## Users and Permissions

Require team authentication. Members manage their team's contracts; each contract identifies a responsible member.

Restrict customer, landlord, and supplier agreements to their designated sales, property, legal, or finance staff and permitted locations; a location grant alone need not expose every contract category.

## Data and Ownership

Contracts have a name and belong to a team; obligations store description, due date, and completion. Store agreement versions and term history with counterparty, owner, file version, effective dates, entered notice period, and status. Signed/executed files and old term dates remain immutable. Obligations refer to the applicable term and retain completion attribution.

Record agreement category, location, customer organization or supplier/landlord, related resource references, entered pricing terms/currency, and applicable notice/renewal dates. These references identify the agreement's subject, without creating inventory reservations.

Customer, supplier, location and employee references resolve to CanCustomer, CanPurchase, CanRent catalog and CanOnboard respectively. Executed agreement snapshots remain frozen even after source maintenance.

## Workflows and Business Rules

Record a renewal as a new term linked to the previous one, not an overwrite of the executed agreement. Display end dates inclusively and expire a term at the following local midnight. Termination cancels future term reminders while preserving the recorded terms and completed obligations.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). The declared Agreements (`/agreements`) page supplies the sidebar entry for authorized sales/property/legal/finance users. Agreement/term details and notice/obligation queues are contextual subviews with conceptual labels. Use daisyUI with category/location/functional restrictions; no extra administration console is needed.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Agreements | End-date-ordered Table/List with category, location, owner, counterparty, status and current term; search Input and category/location/owner Select filters; create/edit Fieldset. | Maintain only scoped agreements and open permitted customer/supplier/location/employee references from their owning packages. |
| Executed terms and amendments | Agreement Card, term Tabs/List with file download Buttons, inclusive effective/end dates, timezone, entered pricing/currency and execution status; attributed amendment Collapse. | Execute, renew or terminate through existing operations. Renewal adds a linked term; executed files and old dates remain immutable, preserving source snapshots. |
| Notice queue | Upcoming-deadline Table with agreement, term, owner, notice date and reminder delivery Badge; Alert for unavailable/failed delivery. | Read recorded notice periods and calendar-day reminders; renewal/termination invalidate obsolete pending reminders. The UI does not interpret legal clauses. |
| Obligations | Overdue/upcoming/completed Tabs and checklist Table/List with due date, applicable term and completion attribution; obligation Fieldset. | Create/edit permitted obligations and complete through their owning operation. Booking extensions and invoices remain separate authorized downstream actions with distinct outcomes. |

Empty queues distinguish no obligations from no filter matches. Keep inclusive end dates and the following-local-midnight expiry meaning readable beside the current term. Pending uploads or term changes preserve the previous executed document; failed transfer leaves its download intact. A stale execution/renewal or immutable-field conflict produces an Alert with the current term and preserves unsaved new-term/amendment text. Confirm discarding edits. On narrow screens stack term Cards and obligation Lists, retaining owner, notice date and currency. Follow related booking/procurement links only under their policies; agreement renewal never displays a fabricated workspace reservation.

## Personal Configuration

Inherit the shared own-user dialog and base settings. Remember an authorized category/location filter and whether executed-term history starts expanded. Display preferences cannot change the contract timezone, notice period, entered legal terms, document access or reminder scheduling. No contract settings/admin tab is needed.

## Interfaces and Integrations

Use D1 for records, R2 for agreements, and EmailService for owner reminders.

Declare links to the relevant customer, booking, or procurement record. Any booking extension or invoice creation is a separate authorized operation with its own outcome.

## Background Actions

Calculate notice reminders in the configured contract timezone using calendar days. Rescheduling or a new term invalidates old reminders. Re-check active/incomplete state before sending notice or obligation reminders; send one logical reminder per recorded term/deadline.

## Error Handling

Explain invalid dates and document-transfer failures. Updating deadlines or completing obligations must update their pending reminders; expose delivery failures.

## Scope and Completion

Complete when renewal preserves the previous executed file/terms, inclusive end-date expiry is correct, and obsolete reminders do not survive termination or renewal. This tracks terms supplied by users; it does not interpret legal clauses.

A manager can retrieve the customer's signed agreement, identify the current term and notice deadline, and renew it without silently extending workspace availability.

Frontend completion additionally requires these journeys:

- A manager retrieves a signed customer agreement, checks its inclusive end date and notice deadline, renews into a new term and can still download the original executed version without seeing a fictitious booking extension.
- A completed obligation and a terminated/renewed term stop their obsolete reminders, while retained completion history and any delivery failure remain visible.

## Composition and Ownership

Recommended placement: Agreement administration module. Own executed versions, terms, obligations and amendments. Reference customers, suppliers and locations from their owners. Agreement renewal is distinct from paid membership renewal or an extended room reservation. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

### Frozen execution and reminder lifecycle

Execution freezes the contract timezone, attributable signer/time and party/location text snapshot alongside its immutable file and dates. Inclusive term expiry is a keyed occurrence at the next local midnight; recording an already ended term marks it expired immediately. Renewal retains old evidence and suppresses obsolete old-term notice work. Termination preserves history and prevents dispatch of outstanding term/obligation reminders.

Changing an incomplete obligation deadline replaces its keyed occurrence and rechecks the exact resulting revision both when due and at dispatch. Reminder outcomes are separate immutable-source delivery records with pending/delivered/failed/unknown state. Category/location/owner eligibility remains a prospective authorization check; later employee-directory changes cannot rewrite executed evidence.
