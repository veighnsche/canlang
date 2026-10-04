# CanCRM requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanCRM.can](CanCRM.can).

## Purpose and Adoption Goal

Help workspace sales teams turn inquiries into tours, quotes, and office or coworking sales. Adoption depends on seeing the customer's preferred location, space needs, and next dated action.

## Users and Permissions

Authenticate team members. Companies, contacts, and deals stay within their owning team; a deal's owner is a member of that team.

## Data and Ownership

Companies store name/website; contacts store name/email; deals have a title. Companies and contacts belong to a team; contacts may link to a company. Deals link a contact to a value/currency, owner, stage, notes, and next-action text. Retain stage changes with actor/time and closure outcome. Archived companies/contacts remain identifiable on existing deals.

Record company billing/contact identity, lead source, preferred locations, requested workspace type, seats, intended start/duration, and a dated next action with responsible salesperson. Retain attributed calls, emails, tour notes, and lost reasons as activity history.

In the composed customer/sales profile company, individual and contact identities are references to CanCustomer-owned models. The sales package owns deal/stage/activity data; historical prospect snapshots remain attributed and reviewed duplicates use the canonical alias workflow.

## Workflows and Business Rules

Support lead, qualified, proposal, won, and lost stages, including explicit reopening. Advancing moves lead to qualified, then qualified to proposal; closing and reopening use their dedicated operations. Ordinary edits apply only to open deals. Ownership changes require an active sales-team member. Archiving a referenced contact/company must not delete or detach a deal's history. Pipeline totals are grouped by currency rather than adding unlike amounts.

Flag likely duplicate company/contact records for staff resolution rather than silently merging them. A won deal records the resulting customer and booking/membership reference; winning a deal does not itself reserve space or confirm payment.

Company account creation/invitation is an authorized CanCustomer operation. Closing a deal does not grant a company colleague a paid seat or billing role; such outcomes are explicit downstream actions with returned states.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). The declared Sales pipeline (`/sales`) page supplies the sales-user sidebar entry. Company/contact, deal, Next actions and contact-transfer destinations below are contextual subviews, with conceptual labels pending page design. Use daisyUI stage-grouped Lists/Tables and currency-separated Stat cards.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Sales pipeline | Stage Board of deal Cards with stage/value/seats/next-action Badges and Stat; title search with location/owner/stage filters and remembered defaults; selected-currency Stats via an explicit currency Fieldset. | Create/edit permitted deals, advance stages, close won/lost and explicitly reopen through owning operations. Winning records returned customer/booking/membership references without inventing payment or reservations. |
| Companies and contacts | Searchable Customer/Contact Lists with kind/active Badges and Pagination; likely-duplicate Collapses with Alert (company candidates also annotated by Tooltip); role/invitation Badges with explicit Buttons. | Navigate canonical CanCustomer-owned identities in the composition; company/contact maintenance and reviewed aliases retain their own authority and do not transfer company roles. |
| Deal and activity | Explicit Fieldset for title/start/workspace/notes with generated controls for owner/value/seats/duration/source/next-action; stage/close/reopen/link Modals; chronological activity Timeline with chat bubbles and quote value Diffs, with an authorized company activity overview across its linked deals and contacts. | Assign only active sales-team owners; record attributed activity, quote/tour links, confirmed sale reference or lost reason while retaining history. |
| Next actions and contact transfer | Overdue/upcoming Table showing date, salesperson and deal; CSV import Fieldset with row-validation Table and duplicate preview, plus scoped export Button. | Resolve/import only authorized valid rows; never silently merge duplicate contacts. Related tour/proposal/account actions use their declared owning operations. |

Distinguish no matches from an empty pipeline; preserve filters on linked records. Pending stage/ownership actions show their current operation outcome; stale or cross-team references produce an Alert without silently overwriting saved context. Preserve unsaved notes and CSV preview on recoverable errors. Archived contacts remain identifiable in history even when editing is unavailable. Narrow screens stack deal Cards and activity, keep next-action date/owner prominent, and move filters into a Collapse without hiding currencies. Downstream invitation or paid-seat failures stay separate from successful deal closure.

## Personal Configuration

Inherit shared base settings in the own-user dialog. Offer remembered pipeline stage/location filters and an overdue/upcoming follow-up tab, plus the inherited compact/comfortable presentation, limited to authorized sales records. These preferences do not change team ownership, company roles, currency calculation, sales stages or the canonical customer directory. No settings/admin console is required.

## Interfaces and Integrations

Use D1 for records and shared authentication/team capabilities.

Declare links or capabilities for tour appointments, priced proposal revisions, and confirmed booking/membership outcomes. One external outcome cannot create repeated won-sale activity.

## Background Actions

None in the first version.

## Error Handling

Explain missing required fields and invalid values. Reject references to contacts, companies, or owners outside the record's team.

## Scope and Completion

Complete when a salesperson can find a company/contact, maintain deal context, close/reopen a deal, and retain history after referenced records are archived.

A salesperson can qualify an inquiry for a six-seat day office, schedule a tour, record a quote, and retain the confirmed sale or lost reason with its follow-up history.

Frontend completion additionally requires these journeys:

- A salesperson qualifies a six-seat day-office inquiry, opens its linked contact, records tour/quote activity and a dated follow-up, then closes and reopens the deal with full stage history.
- A duplicate CSV row remains visible for review; archiving a referenced contact leaves existing deals attributable, and unlike-currency pipeline amounts remain separate.

## Composition and Ownership

Recommended placement: Customer and sales. Reference canonical CanCustomer company/contact models; own prospects, deals, sales activity and acquisition follow-ups. Compose with CanBook, CanPropose and CanSuccess without cloning their calendars, offers or account actions. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Draft refinement status

The source and handwritten JavaScript now retain confirmed sale evidence by referencing an existing exported `rent_reservations.Booking` or `member_terms.Term`. Winning requires exactly one: a confirmed/occupied/completed booking for the deal's customer and location, or a paid membership term for that customer covering the location. It neither reserves inventory nor initiates or confirms payment. The immutable, team-owned Sale record has unique booking/term references, preventing the same commercial outcome from producing another won-sale activity, including after reopening or on a different deal in the team. Prior sale and loss evidence remains in history when a deal reopens.

CRM now imports the real owning appointment and offer models/operations. The tour section filters published CanBook calendars at the deal location, shows timezone/windows/type/duration, and submits `appointments.book` with the deal's canonical customer/contact. It displays the resulting appointment coordination state on the next authorized page reread and exposes the owning cancel/attendance operations. `appointments.book` retains its original authenticated caller and verified-own-contact-or-host-manager guard; a CRM salesperson cannot schedule for another contact without the existing host grant. Pending host/room coordination remains distinct from confirmation.

The quote section submits canonical `Proposal.create`, `revise`, Item CRUD, `send_offer`, `document`, and `request_booking`. Its inputs retain the deal customer, contact, location, currency and seat count. Draft items stay under CanPropose's existing draft-only write guard; issuing freezes pricing, and an accepted quotation still needs a separate inventory handoff. The `propose.salesperson` and `crm.salesperson` roles remain separate canonical grants. No provider signature, operation description or input schema is duplicated in a consumer wrapper.

CRM-owned `record_tour` and `record_quote` add attributed activity containing an actual immutable Appointment or Revision reference. Both require the deal's customer/contact/location to match the owning record and reject repeated references within a deal. A tour can retain pending coordination without claiming confirmation. Quote evidence requires sent/accepted/declined state; a draft cannot count as an issued offer. The reference remains bound to that exact revision after newer revisions appear. Existing reviewed HTTP(S) links remain optional staff evidence and never stand in for scheduling or issuing.

The Sales page supplies canonical customer/contact creation, maintenance and archive controls, reviewed company alias resolution, contact claim, administrator recovery, invitations and company-role outcomes. Every control keeps its owning CanCustomer permission and location/company guards. Aliasing neither rewrites historical deals/documents nor transfers account roles. Likely duplicate candidates compare kind/case-folded company name or exact contact email under current directory grants; they are candidates, not identity proof. Contact duplicate columns exclude `parent`, which is outside the limited directory-reader grant. No company/contact policy was widened.

The customer timeline includes archived customer identities and chronological linked deal activity. Overdue/upcoming next-action tabs remain a presentation preference over one shared table. Pipeline results remain separated by the selected currency. Collection and typed pipeline CSV export uses the shared authorized export contract.

Remaining draft boundaries are explicit:

Customer and Contact intake forms now enable the canonical CSV review mode. Their owner-exported duplicate reads preserve exact contact-email and case-folded same-kind customer matching. Preview keeps invalid/duplicate rows, and confirmed rows use owning CRUD with current guards and stable per-row identities. Changed candidates require renewed review; successful earlier rows remain visible when another row fails.
Owner assignment combines `can_work` with the canonical `salesperson(row.owner)` predicate. Both current location eligibility and the explicit role are required. The inline update examples distinguish the caller from an active colleague who lacks that role; historical ownership remains valid after later role removal.
- CanBook's broader rescheduling and compensation journeys remain owning appointment-workflow work; exporting operations does not by itself implement them.

All JavaScript imports remain proposed, unimplemented contracts. The handwritten target now mirrors canonical provider controls and typed CRM evidence. Focused parser acceptance and `node --check` validate syntax only; operations, examples, provider outcomes, permissions, archive behavior, replay and rendering were not executed. Added inline CRM examples cover pending versus confirmed tour evidence, issued-versus-draft quote evidence, role rejection and duplicate references; canonical customer alias examples cover reviewed success, self-alias/blank-reason/role rejection and repeated mapping. Existing confirmed-sale and loss examples remain intact. Imported provider fixtures are test-only and erased from the future production artifact.

Standalone CanCRM explicitly selects the customer, appointment and proposal owners alongside crm, so canonical recipient, invitation and own-appointment routes actually exist. Package imports alone would not mount those pages. Composed CustomerSales still deduplicates each canonical owner and all existing page guards remain in force.

## Reviewed research intake

CanDiscover calls the exported `crm.promote_research(source,input)` operation with a `ResearchLead`, after its researcher has reviewed the evidence and chosen an existing customer, contact and location. The caller must currently hold the salesperson role and location eligibility; the customer must remain active, the contact must belong to it, and the nonnegative value must use the location currency. Research does not create company identities or infer a sales outcome.

The CRM atomically creates one lead and an immutable ResearchIntake binding the namespaced discovery identity, exact reviewed input and resulting deal. Replaying that identity with the same input returns the same deal under current authority; changed input rejects rather than updating the deal or creating a duplicate. Subsequent ordinary deal edits do not alter the intake evidence. The source identity is not an access credential. The research app exposes its existing canonical promotion control; no extra CRM page or duplicated workflow is needed.

Inline examples and the handwritten target include new intake, current authority and currency rejection, identical replay and mismatched replay. They remain draft test specifications, not executed behavior.
