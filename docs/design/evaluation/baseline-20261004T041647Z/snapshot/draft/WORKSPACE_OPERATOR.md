# Workspace operator application context

This is the shared business context for the 39 `Can*.md` app/package requirement documents: the original 35 sketches and four additional modules. [Portfolio composition](PORTFOLIO.md) defines recommended deployments, internal package boundaries, canonical record ownership, and acceptance journeys. It complements [canlang requirements](../REQUIREMENTS.md); it defines application behavior, not new language syntax. All 39 companion `.can` sources have now been rewritten, including customer, reception, mail and reporting. [Migration coverage](MIGRATION.md) records remaining behavior/design gaps and validation limits; the expanded requirements below remain the completion target.

## Business and product scope

Assume one hypothetical operator offering short workspace rentals across multiple locations: individually bookable desks, pooled coworking zones, day offices, hourly meeting rooms, rentable event spaces, and individual/company memberships with identified recurring terms and usage allowances. Customers include individuals and company billing contacts; employees include reception, community, sales, facilities, finance, HR, and managers. An initial deployment can have one location without changing these rules.

The product framing is inspired by the publicly described [WeWork On Demand workspace types](https://www.wework.com/solutions/wework-on-demand) and [Spaces offices, coworking, and meeting rooms](https://www.spacesworks.com/). These requirements describe our hypothetical operator's choices; they do not claim either company uses these apps or follows our workflows.

Every app must have a usable business flow, relevant staff/customer pages, and clear exception outcomes within its stated initial scope. A customer should be able to find a space, understand the quoted price and conditions, book/pay, retrieve confirmation and an invoice, arrive/check in, request help, and cancel or renew where applicable. Staff should be able to resolve conflicts and account for changes without silently deleting evidence.

## Common records, identity, and location scope

Use explicit references for the operator, location, customer organization/contact, resource, employee, booking, and billing term where needed. A location supplies address, timezone, local operating hours/holidays, and its configured currency; quantities, prices, and rates carry their units. Do not add fictional locations or import either named company's customers, prices, or brand assets.

The authenticated staff team represents the operator. Location grants and functional roles constrain staff reads and mutations; operator-wide authority is explicitly granted. Location managers cannot use cross-location references or exports to escape those grants. Records with several applicable locations must define the authorized intersection for each action. Finance, HR, recruiting, private contracts, customer notes, and documents retain their additional field/record restrictions.

Customer members are not employee team members. Customer billing contacts, learners, advocates, attendees, and volunteers use verified external identities with explicit own-record or organization-role policies. Company customer administrators may manage only the contacts/bookings/billing records explicitly granted by that app. Matching an email domain or receiving an operator invitation does not create customer-organization authority. Public discovery never reveals another customer's booking, attendance, support conversation, or account details.

A location's configured timezone governs its local booking days, opening hours, and deadlines. Multi-location views display the location/timezone beside each timed event. Currency-grouped reporting is mandatory; the initial apps do not infer exchange rates or combine unlike currencies.

## Ownership and integrations

CanRent is the authority for individually assigned resources and pooled saleable capacity, downtime, and recorded workspace occupancy. CanBook handles tours/consultations and host availability; CanEvent and CanVolunteer handle their attendee capacities. A tour, event, or community activity requiring a rentable room must use the CanRent reservation authority. CanTable, where enabled, owns café table occupancy, not office inventory. CanShift owns staff roster assignments; CanField owns service-visit records; CanBook owns host appointments. When these workflows use the same employees, they share one configured operator employee-schedule authority. A service visit or host appointment may be contained in its employee's eligible published duty shift, but cannot overlap another visit/appointment, incompatible duty, travel buffer, or authoritative absence. Swaps and roster changes must reject incompatible existing visits/appointments until their owners resolve them. A standalone CanField deployment may own its employee schedule; connecting CanShift requires explicitly migrating/connecting that authority, not creating a second calendar.

CanMember owns plans, paid terms, company seat assignments, and identified product/time allowance reservations and consumption. Eligibility alone does not reserve a room, consume credits, confirm a payment, or provision a physical key. CanCustomer owns company roles; CanReception owns visitor and physical credential lifecycle; CanMail owns optional physical mail handling. CanContract retains entered agreement terms; signing or renewing a document does not implicitly extend a reservation. CanPropose owns frozen offers and customer decisions; acceptance does not imply available inventory.

Configure exactly one payment collection owner for each source charge. In the composed operator profile CanInvoice owns booking, membership-cycle, event-ticket and declared add-on charge collection; a standalone sketch may instead configure its one direct adapter. Never run both for the same charge. Recurring generation, consent, attempts and failed-payment outcomes identify the exact source cycle. CanInvoice owns issued invoice/credit documents and its recorded balance; payment evidence must be reconciled with the source. CanRefer owns fixed member-referral cash rewards; CanAffiliate owns contracted broker commissions. A declared qualification rule decides eligibility and prevents unintended duplicate program rewards.

Apps may be independently deployed or composed through explicitly specified capabilities. Use the canonical customer/company source in CanCustomer, employee source in CanOnboard, location/resource source in CanRent catalog, and supplier source in CanPurchase. These are owning packages, not a mandatory directory deployment per app. Shared references do not imply cloned CRUD, automatic imports or transactions across deployments. Configure authorized source lookup and reviewed alias migration when a record is shared. Declare each connected capability's accepted inputs, source/operation identity, authorization, returned states, and reconciliation behavior in the consuming requirements before implementing it. A link to another app is navigation, not authorization or proof of a committed outcome.

Do not assume a transaction across databases, resource authorities, providers, or deployments. Persist pending coordination, retry with stable identities, and expose conflicts/failure/uncertain outcomes. Success messages and customer access follow the authoritative result. Compensation releases provisional holds or recorded allocations where safe; it does not pretend an already delivered payment or message was undone. One unavailable optional app must not prevent unrelated core operations; any flow that actually depends on it remains visibly pending or unavailable.

## Required connected-business contracts

The following are business contracts, not proposed `.can` syntax. Enable only the installed connections. Every mutation carries authenticated source identity, a stable operation ID, owning operator/location, and expected source revision; the receiver validates references and returns its saved result on a matching retry. Read responses apply both caller and source permissions. An unavailable source cannot be interpreted as a successful reservation, payment, eligibility check, or repair release.

| Capability and owner | Required input/evidence | Returned result and reconciliation |
| --- | --- | --- |
| Workspace hold/move/release — CanRent | Named resource or pooled zone, intervals, seats/party size, purpose/source reference; move/release also identify existing hold and revision | Hold/booking ID, frozen interval/price/terms, expiry and pending/held/confirmed/released/expired/conflict state; query by operation ID after uncertainty |
| Booking fulfillment — CanRent | Capacity hold, priced source revision, required allowance reservation, authenticated full remaining-money payment evidence or authorized free/on-account reason | Confirmed booking and charge reference, or expired/unavailable/needs-resolution result; received payment cannot be discarded |
| Resource downtime — CanRent | Resource, interval or explicit indefinite block, repair reference, manager authorization; release names the block | Applied/pending/conflict state, affected booking references under scope; releasing one block cannot clear another repair block or physical occupancy |
| Membership eligibility — CanMember | Verified customer user/company role, paid seat/term, location/product, intended booking/access interval | Eligible/ineligible result with applicable paid term/assignment, benefit revision, permitted hours and validity; re-check at fulfillment and access, return unavailable distinctly |
| Invoice charge/settlement — CanInvoice | Stable source charge ID, customer billing identity, service lines/dates/location, frozen amount/currency, booking or term reference | Invoice/document ID and issued/collection-pending/settled/credited/refund-pending outcome with payment/adjustment references; validate the precise charge and term before source activation |
| Offer handoff — CanPropose to CanRent | Accepted immutable proposal revision, verified recipient, dates/resource choice, snapshotted price/terms and optional hold | Pending/confirmed/accepted-awaiting-alternative result with booking reference; preserve accepted terms on any failed handoff |
| Repair/service handoff — CanMaintain to CanField | Repair and resource/location references, priority, instructions, permitted report audience | Pending/assigned/blocked/completed job and attributed report reference; completion returns repair for manager verification, not automatic resale |
| Employee scheduling — shared schedule authority | Employee, location, skill/role, interval/buffers, shift or service-job reference, applicable absence and revision | Reserved/published/conflict/pending state; roster and job updates observe the same commitments, compatible parent duty shift, and absence state |
| Leave to schedule — CanLeave | Approved/cancelled employee absence, local dates and recorded work-calendar calculation, version | Applied/pending and affected shift/job conflicts; an absence is not synchronized until accepted by the schedule authority |
| Reward qualification/reversal — source billing/booking to CanRefer, CanAffiliate, or CanLoyalty | Program, unique source sale/customer identity, amount/currency, attributed evidence, qualifying paid/completed/cancellation milestone and revision | Credited/reversed/ineligible/pending result and immutable reward entry; each configured program validates its own rules and refuses conflicting source-ID reuse |
| Approved time charge — CanTime to CanInvoice | Approved entry revision, customer/location/service, frozen duration/rate/currency and source identity | Invoice charge reference or validation/pending result; repeated export cannot create another charge |
| Company roles — CanCustomer | Organization, verified user, explicit role/action/location scope and invitation/grant revision | Allowed/denied/unavailable with source revision; removal revokes organization authority immediately and reports dependent reconciliation |
| Paid-seat allocation — CanMember | Paid company term, eligible organization user, seat type/capacity and expected term revision | Assigned/released/conflict/pending seat evidence; replays and concurrent assignments cannot exceed capacity |
| Usage allowance — CanMember | Beneficiary/term/period, product and exact units, booking identity; consume/release names reservation and revision | Reserved/consumed/released/expired/insufficient/pending result with ledger ID and expiry; no implicit points or currency conversion |
| Recurring cycle — CanMember to CanInvoice | Unique cycle/term, customer, frozen amount/currency, service period, due date and current renewal/collection consent | Invoice and attempted/settled/confirmed-failed/unknown outcome; the source activates only that paid term |
| Guest eligibility/credential action — CanReception | Verified guest/host, visit/location/window, booking/term evidence; issue/revoke also names credential and permission version | Admitted/refused/pending and separately desired/device-confirmed issue/revocation state; guest departure cannot clear room occupancy |
| Purchase receipt — CanPurchase to CanStock | Unique order-line/receipt, trusted accepted quantity/unit/location and reversal reference if returning | Posted/pending/conflict stock movement ID; received goods remain recorded while projection retries |
| Inspection result — CanMaintain/CanField | Asset/plan/occurrence, frozen checklist, assigned inspector, result/evidence and version | Accepted/blocked/failed result and linked repair/verification action; passing a checklist alone cannot release another downtime block |
| Operational report — CanReport | Authorized metric, location/date/timezone/currency/unit scope, requested source checkpoint | Defined result with completeness/freshness, source revision and permitted drill-down; never a business mutation |
| Mail entitlement/handling — CanMail | Current customer service/recipient/delegate grant, location, item and handling instruction version | Accepted/collected/forward-pending/forwarded/returned evidence; service expiry is not proof of disposal or physical return |

Provider-controlled outcomes are not accepted from browsers or ordinary staff CRUD. Connected flows re-query authoritative current state before a consequential decision; asynchronous snapshots remain marked pending/stale where relevant. Where an app supplies only a related-record link, omit the capability entirely and keep the business action manual and explicit.

## End-user administration

[End-user administration scope](ADMIN_SURFACES.md) independently assesses every module. Only CanCustomer, CanMember, CanRent, CanLoyalty, CanFeedback and CanTrade require an app-specific end-user admin responsibility in this scope: own-company access, shared membership/booking/reward rules, or moderation of other users' content. Optional loyalty/marketplace responsibilities exist only when their products are enabled. Those six requirements state the precise business action and audience; the other 33 modules have no added admin section or settings area.

Normal finance, HR, teaching, event organization, dispatch, review, support and reception work retains its existing actor/record permissions and normal product pages. A staff/customer page distinction does not create an admin side. Shared canonical account/team controls remain common infrastructure and are not duplicated into per-app administration features.

Developers maintain technical setup directly in the authoritative database/configuration. Project/site/check provisioning, SDK wiring, API/ingestion keys, service bindings, quotas, technical retention/retry defaults and reporting source definitions have no end-user configuration forms or MCP business tools. The six business admin views use their existing owning operations and cannot bypass committed snapshots, payment evidence, moderation authorship or company/location scope.

## Usability and initial business controls

Every employee-only operation re-checks active work identity and functional/location permission; inactive employment cannot remain authorized merely because a cached team invitation or role exists. Customer roles remain separate. Every staff collection provides location and applicable date/status/owner filters with bounded search/pagination. Customer pages expose only authorized own records and show the relevant location, local time, price/currency, terms, and outcome before a consequential action. Support narrow-screen reception/technician/customer use and accessible controls through the shared presentation primitives; no separate native mobile application is required.

Operational records retain actor/time evidence, original terms, attributed corrections, and related source references. Financial records distinguish quoted, reserved, issued, paid, credited/refunded, and manually evidenced settlement where applicable. Booked or paid totals are not inferred from draft quotes, tracker events, email delivery, or occupied-room estimates. Booking and occupancy reports state their time range and inclusion rules.

Provide authorized CSV export for primary operational records with existing location/field scope, currency/unit labels, and version/source identifiers where needed. Exports must not expose hidden fields or treat partial data as a complete operator ledger. Imports are required only where an app states an intake/import flow and must validate team/location links, duplicates, and failed rows. Export is not a promise of a complete backup/restore facility.

Cancellation, no-show, refund, reminder, qualification, and retention policies are entered operator rules, displayed where relevant and snapshotted when committed. Apps do not interpret agreements, determine jurisdiction-specific entitlements, or infer undisclosed fees. The fuller operator profile now includes pooled coworking capacity, company paid seats, product/time allowances, identified recurring billing cycles and failed-payment handling. Physical credential tracking is required for reception; device control is an optional configured adapter. Deposit/partial-payment accounting, currency conversion, long-term property leasing, payroll, statutory reporting, automatic vendor payment, mail opening/scanning and call answering remain deferred. These business requirements do not imply that the old sketches already implement them.

## App roles and optional operations

| App | Workspace-operator job | Fit |
| --- | --- | --- |
| CanRent | Named/pool capacity, booking, allowance/payment coordination, arrivals and occupancy | Core customer operations |
| CanMember | Paid seats/terms, usage allowances, recurring renewal and member content | Core when memberships are sold |
| CanInvoice | Invoices, credits, cycle collection, failed-payment handling and receivables | Core billing |
| CanBook | Tours, sales consultations, and onboarding appointments | Customer operations |
| CanCRM | Workspace inquiries and sales pipeline | Sales |
| CanPropose | Priced workspace offers and recorded customer acceptance | Sales |
| CanContract | Customer, property, and supplier agreement tracking | Business administration |
| CanDesk | Customer support and reception conversations | Customer operations |
| CanMaintain | Assets, inspections, repairs and resource downtime coordination | Location operations |
| CanField | Technician, cleaning, and setup service visits | Location operations |
| CanShift | Published employee rotas and replacements | Staff operations |
| CanStock | Consumables and supplies by site/storeroom | Location operations |
| CanDo | Daily location checklists and follow-up tasks | Staff operations |
| CanSuccess | Customer move-in, account follow-up, and renewals | Account management |
| CanEvent | Member events, registration, tickets, and check-in | Community operations |
| CanFeedback | Facility/service suggestions and roadmap decisions | Community operations |
| CanLoyalty | Repeat-visit points and manually fulfilled perks | Optional loyalty program |
| CanRefer | Member referral cash rewards and manual settlement | Optional acquisition program |
| CanAffiliate | Broker commissions and provider settlements | Optional partner sales channel |
| CanHire | Location-based recruitment and private interviews | HR |
| CanOnboard | Canonical employee work identity and readiness checklists | HR |
| CanLearn | Staff induction and member orientation | Training |
| CanLeave | Employee leave and absence visibility | HR |
| CanExpense | Employee claims and reimbursement evidence | Finance |
| CanPurchase | Suppliers, approvals, purchase orders/receipts and budget consumption | Finance |
| CanTime | Service/project time and approved billable exports | Staff/service operations |
| CanApprove | Plans, procedures, and supplier document review | Administration |
| CanBoard | Leadership meeting papers, minutes, decisions, and actions | Governance |
| CanStats | Tracked website traffic and acquisition goals | Digital operations |
| CanCatch | Application error intake and triage | Digital operations |
| CanCheck | Scheduled-job heartbeat monitoring | Digital operations |
| CanTable | Café or restaurant waiting list and table service | Optional café operation |
| CanTrade | Member services and surplus-equipment listings | Optional member marketplace |
| CanGrant | Funded startup/community cash-award selection | Optional funded program |
| CanVolunteer | Mentoring, charity, and community volunteer activities | Optional community program |
| CanCustomer | Canonical customers/company roles, invitations and billing profiles | Shared customer package |
| CanReception | Guest visits and physical key/card handling | Reception operations; optional device adapter |
| CanMail | Mail/parcels, recipient/delegate collection and forwarding evidence | Optional mail/virtual-office service |
| CanReport | Utilization, cash receipts, receivables, renewals and service backlog | Shared operational reporting package |

All 39 requirement modules can serve this hypothetical business, but the optional operations require an actual business choice; they are not mandatory just because the operator rents offices. Focused examples remain useful, while the [composition plan](PORTFOLIO.md) consolidates related requirements into fewer deployments and assigns one owner per record/authority. Installing the whole portfolio is not a prerequisite for a small operator's booking workflow. Ordinary operational reporting reads authoritative sources; website tracking remains separate.
