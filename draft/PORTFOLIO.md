# Workspace operator portfolio composition

This is the accepted business composition plan for the [workspace operator requirements](WORKSPACE_OPERATOR.md). It uses the existing [package composition model](../REQUIREMENTS.md#packages-and-files); it does not change language/runtime design. App names below identify requirement ownership. All existing requirement documents and `.can` sketches remain as focused examples. No file rename, deletion, source migration, new runtime primitive, or separate deployment is implied by consolidation.

## Recommended applications and packages

| Composed application | Requirement packages | Boundary |
| --- | --- | --- |
| Workspace | [CanRent](CanRent.md), [CanMember](CanMember.md) | Catalog/pricing, reservations, fulfillment, member plans/benefits, billing terms, portal content |
| Customer and sales | [CanCustomer](CanCustomer.md), [CanCRM](CanCRM.md), [CanBook](CanBook.md), [CanPropose](CanPropose.md), [CanSuccess](CanSuccess.md) | Canonical customers/company roles, pipeline, appointments, offers, account follow-up |
| Facilities | [CanMaintain](CanMaintain.md), [CanField](CanField.md), [CanStock](CanStock.md) | Asset/repair/inspection records, technician dispatch, consumable stock; distinct ledgers and schedules |
| Finance | [CanInvoice](CanInvoice.md), [CanExpense](CanExpense.md), [CanPurchase](CanPurchase.md) | Customer billing, private employee claims, supplier/PO/budget records; shared interface with distinct grants |
| People development | [CanHire](CanHire.md), [CanOnboard](CanOnboard.md), [CanLearn](CanLearn.md) | Private candidates, canonical employee records/readiness, versioned training and its separate audiences |
| Staff scheduling | [CanLeave](CanLeave.md), [CanShift](CanShift.md) | Absences and published rotas sharing authoritative employee commitments; leave reasons remain private |
| Referrals and partners | [CanRefer](CanRefer.md), [CanAffiliate](CanAffiliate.md) | Shared sale attribution and cash-reward review; program qualification and manual/provider settlement remain distinct |

Within a composition use one declared app context, one owner per model, canonical operations, and explicit package references. Keep package files separate when that helps navigation. Standalone example use remains supported through an explicitly configured source or local owner; connecting it later requires reviewed migration/aliases and reconciliation, not creating parallel directories or authorities.

[CanReception](CanReception.md) supplies a distinct reception app/package. [CanMail](CanMail.md) is an optional distinct mail-service app/package. [CanReport](CanReport.md) is a shared operational reporting package initially surfaced in workspace and finance; an independent reporting deployment is optional.

The remaining focused modules retain their own business ownership: [CanDesk](CanDesk.md) customer support; [CanDo](CanDo.md) independent tasks and a federated work queue; [CanTime](CanTime.md) reviewed time; [CanLoyalty](CanLoyalty.md) points/perks; [CanEvent](CanEvent.md) event admission; [CanFeedback](CanFeedback.md) suggestions; [CanTrade](CanTrade.md) marketplace; [CanVolunteer](CanVolunteer.md) volunteer capacity/tasks; [CanApprove](CanApprove.md) submitted document decisions; [CanContract](CanContract.md) agreements; [CanBoard](CanBoard.md) governance records; [CanStats](CanStats.md) website tracking; [CanCatch](CanCatch.md) application errors; [CanCheck](CanCheck.md) job heartbeats; [CanTable](CanTable.md) café occupancy; and [CanGrant](CanGrant.md) funded awards. They may share navigation where useful. A category or dashboard does not merge permissions, operational state, or retention.

Café, marketplace, loyalty, volunteering, funded grants, broker sales, and mail handling are enabled only when offered by the operator. They are not prerequisites for a small booking deployment. CanCatch, CanCheck, and CanStats remain different digital capabilities even when shown in one operations interface.

## End-user admin composition

[End-user administration scope](ADMIN_SURFACES.md) limits app-specific admin responsibilities to CanCustomer (company roles), CanMember (shared plans/benefits), CanRent (published commercial catalog/booking policy), optional CanLoyalty (reward-program terms), CanFeedback (moderation/operator roadmap) and optional CanTrade (moderation). These are existing-app business views, not six new deployments or a global admin console.

The other 33 modules use their normal workflows. Organizer, instructor, reviewer, finance, dispatch, HR and reception permissions do not require extra admin sections, settings landing pages or management packages. Different user journeys may still have separate ordinary pages. Technical setup is developer maintenance under the [shared writer fence, provider-switch and composed recovery rules](ADMIN_SURFACES.md#maintenance-provider-changes-and-recovery), with no UI/tool requirement. Composition does not duplicate canonical account/team controls or give a broad administrator access to every module.

## Internal package boundaries

CanRent separates catalog/pricing, reservations/availability, fulfillment/occupancy, and local reporting. Catalog owns locations and resource descriptions; availability owns scarce capacity, buffers, and downtime; fulfillment owns booking arrival/departure evidence. Reports read these records. A package boundary never creates a second authority for the same resource.

CanMember separates plan/entitlement rules, membership terms/seats/allowance ledger, and portal content. CanMember generates identified billable cycles and eligibility outcomes; CanInvoice owns invoice/collection evidence in the composed operator profile. Content publishing cannot grant paid benefits or device access.

Customer and sales shares canonical customer/contact records while keeping prospects/deals, appointments, proposal revisions, and account actions distinct. Facilities links a repair to a service job and verification, instead of copying repair status into an independently editable job. Referrals and partners shares source-sale identities but retains separate reward allocations and payout methods. People development never exposes candidate feedback or HR documents through a learner page.

## Canonical record ownership

| Business records | Owning requirement | Consumer rule |
| --- | --- | --- |
| Customer organizations, individuals, contacts, verified account links, company role invitations, billing profiles | CanCustomer | CRM, membership, billing, support and reception reference one source; issued snapshots remain local and frozen |
| Locations, saleable resource catalog, local hours, rates | CanRent catalog | Other apps reference location/resource IDs and scoped reads; never maintain independently editable location copies |
| Resource holds, pooled capacity, downtime and room occupancy | CanRent reservation/fulfillment packages | Events, appointments, repairs and reception cannot manufacture room availability |
| Membership plans/terms, company paid seats and usage-credit ledger | CanMember | Customer invitations are not seat allocations; loyalty points are not booking credits |
| Issued invoices/credits, customer payment attempts, refunds and receivable balances | CanInvoice in composed profile | One source charge and collection owner; provider outcomes settle the precise booking or term |
| Employee identity/employment status, home location, manager and skill profile | CanOnboard employee package | HR-sensitive fields stay restricted; other modules read required work identity, not cloned employee tables |
| Employee duty/service/appointment commitments and accepted absences | Shared operator schedule authority configured through CanShift, or one declared standalone owner | Compatible visits/appointments can sit inside duty shifts; conflicting work and travel buffers cannot be independently booked |
| Suppliers and purchase orders/receipts/budget commitments | CanPurchase | Facilities and stock reference supplier/receipt IDs; no duplicate supplier maintenance |
| Non-bookable equipment/assets, inspection and repair history | CanMaintain | Stock tracks consumable quantities; CanRent retains saleable-space/resource identity |
| Guest visits and physical key/card issue/provisioning history | CanReception | Booking arrival, guest arrival, event admission and café seating remain separate evidence |
| Physical mail items and handling evidence | CanMail | Membership owns service entitlement; the recipient/collector comes from CanCustomer |
| Reward entries and settlements | CanRefer, CanAffiliate or CanLoyalty for its own program | Shared source-sale attribution cannot create unintended rewards in multiple programs |
| Report definitions and read projections | CanReport | Sources own business facts; projections cannot settle balances or change eligibility |

A consumer may store an immutable committed snapshot or a versioned read projection with freshness. It cannot add competing CRUD for the source model. Correcting a source record never rewrites old invoices, accepted offers, paid plan terms, review decisions, or service evidence. Merging duplicate customers requires attributed alias mapping and preservation of scope, not transferring privileges automatically.

## Overlap decisions

- CanBook owns appointments and host commitments; CanRent owns the scarce room used by one. Both results are required before a room-backed appointment is confirmed.
- CanEvent and CanVolunteer own admission/signup capacity. Their venue must be confirmed by CanRent; they cannot create a parallel room calendar.
- CanDesk owns customer conversation. A CanMaintain repair or CanField job is linked with scoped status; private support notes never become contractor instructions automatically.
- CanDo owns independent tasks. Domain follow-ups, onboarding steps, inspection jobs, board actions and volunteer assignments may appear in its work queue through authorized source references; completion invokes the owning operation. It cannot flip a generic completion flag to approve spending, finish an inspection, or renew a paid term.
- CanApprove reviews immutable submitted documents. Expense, purchase and grant decisions stay in their owning workflows with private-data, balance and self-approval guards, even if they reuse review presentation.
- CanLoyalty owns points/perks; CanMember owns product/time booking allowances; CanRefer/CanAffiliate own monetary rewards. These balances are never merged, converted, or offset implicitly.
- CanReport owns business metrics; CanStats owns instrumented website activity. Customer interest, quotes, accepted offers, confirmed bookings, physical arrivals and received funds are distinct measures.
- Finance grants do not imply HR receipt access; people-development navigation does not expose candidates to all instructors; reception cannot grant company or paid-plan privileges.

## Expanded scope and delivery order

The fuller operator scope now includes customer-company administration, reception, pooled coworking capacity, paid membership seats/usage allowances, recurring billing and failed-payment handling, preventive maintenance, purchasing fulfillment, and operational reports. These are requirements for the composed operator, not claims that old sketches already implement them.

1. Establish source ownership and scoped company/employee identities; compose the short-rental customer, workspace and finance flow.
2. Add company administration and reception; implement paid seats, pooled capacity, usage allowances and identified recurring billing cycles with visible pending outcomes.
3. Add asset inspections, purchasing/stock receipts and reproducible operational reports; then enable the optional business programs actually offered.

Retain full-balance collection per invoice, explicit money/currency rules, immutable terms and evidence, and recoverable coordination. Deposits, partial payment, currency conversion, long-term lease/property accounting, payroll, statutory reporting, automatic vendor payment, and automatic travel optimization remain deferred. Device provisioning is an optional reception adapter; mail opening/scanning and call answering remain deferred.

## Required acceptance journeys

- A company administrator invites a colleague, assigns one available paid seat, and removes it later without changing historical invoices or granting operator staff access.
- A member reserves the last pooled desk and required meeting-room allowance; concurrent requests cannot overuse either authority, and failed coordination releases provisional allocations once.
- An identified renewal cycle creates one invoice; a delayed previous-cycle callback cannot activate a newer unpaid term. A failed collection has a dated customer action and eligibility outcome.
- A permitted host invites a guest, reception issues/returns a key, and host revocation disables future admission while outstanding device/credential actions remain visible.
- An inspection creates a repair, removes an affected resource from sale at the booking authority, and returns it only after recorded verification.
- A partial purchase delivery posts its receipt to stock once; a replay cannot receive twice or release a spent budget amount.
- A scoped manager reproduces utilization/receivables from versioned sources; a missing source displays partial/unavailable instead of zero.
- If mail is offered, a recipient/delegate collects or staff forwards an item once with evidence and no implied room entitlement.
