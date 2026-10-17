# CanPropose requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanPropose.can](CanPropose.can).

## Purpose and Adoption Goal

Help workspace sales teams quote offices, meeting rooms, coworking days, and add-on services to business customers. Adoption depends on a readable scoped offer and clear next steps after acceptance.

## Users and Permissions

Team members manage proposals and items. A recipient must authenticate with the proposal's stored email to view and decide their proposal.

## Data and Ownership

Each revision identifies the customer's display name and verified recipient email. Proposal revisions store item/price/currency snapshots, recipient, an opaque server-issued record identity used as the response-link token, expiry, and draft/sent/accepted/declined/withdrawn state. Retain the exact revision and verified recipient identity for a decision. Default validity is 14 days, configurable before sending.

Include issuing business, customer organization/billing contact, location, proposed resource or workspace type, seats, service dates/times, price unit, explicitly entered tax/discount amounts, and cancellation/payment terms. Each sent revision states whether inventory is held and the hold's separate expiry.

## Workflows and Business Rules

Sending freezes a priced revision. Editing a sent proposal creates a new revision and withdraws the old response link; an accepted price cannot be changed in place. Only the verified recipient decides a current, sent, unexpired revision. Competing accept/decline actions yield one recorded decision.

Acceptance records agreement to the priced revision; it does not claim a booking or payment exists. By default a quote does not hold inventory. An explicit reservation request must re-check availability; if sold out, show accepted_awaiting_alternative rather than a false confirmation. An optional held quote obtains its hold from CanRent and cannot promise availability after expiry.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Offers is the staff navigation index; accepted-awaiting-booking/action queues sit within it. Recipient response routes are contextual links from the addressed revision, not unbound global destinations. Tokens locate quotes; stored verified recipient identity authorizes reading/deciding.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| Offers — permitted sales index | Location/customer filters, proposal Table, state/expiry Badge and item Fieldsets showing quantities, units, prices, tax, discount and total/currency | Create proposals/items through owning actions; revise before sending, send/freeze a priced revision and copy its response link |
| Revision detail — contextual staff view | Revision history List with issuer/customer snapshots, location/resource, seats, service interval, terms and document Button | Create a fresh revision when terms change; retain/withdraw old response links according to the canonical workflow |
| Your offer — contextual verified-recipient view | Readable frozen quote Card and itemized Table; expiry, held/not-held inventory state and separate hold deadline Alert | Accept/decline only the current sent unexpired revision; print/download the frozen quote and view the recorded decision |
| Booking follow-up — staff queue/contextual recipient outcome | Accepted-awaiting-booking or alternative status Badge, required next steps and explicit pending/confirmed/unavailable handoff outcome | Request reservation through the owning availability authority; preserve accepted price/terms and resolve sold-out results without false confirmation |

Stack item labels and complete totals/terms on mobile; keep decision and expiry context together. Distinguish loading, no offers and no queue/filter matches; preserve unsaved draft items or decision input after failure. A withdrawn/expired old link remains readable as allowed but has no active decision control. Stale pricing explains the current revision instead of silently accepting changed terms. Separate failed email/document generation from quote state. A pending inventory handoff never becomes a confirmed booking on browser return, and an expired hold cannot promise availability. No additional sales/recipient administration console; exclude provider/integration setup from settings.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Staff may save authorized location/state filters and accepted-follow-up view; recipients may choose an itemized versus summary reading default while complete terms remain available. Clear/reset and validate saved grants. These settings cannot change quote validity, recipient identity, tax/discount, sent prices, inventory holds or booking authority. Printed/downloaded quote facts remain tied to the frozen revision; view preferences never replace an explicit accept/decline decision.

## Interfaces and Integrations

Use D1 for revision/decision records and EmailService for delivery. Response tokens locate a revision, while verified recipient authentication authorizes access. Revoked links and cached pages cannot continue to offer an active decision.

Declare priced-booking handoff and invoice creation capabilities with stable source identity. A handoff preserves the accepted revision and reports pending, confirmed, or unavailable outcomes.

## Background Actions

Send the proposal email when it becomes sent.

## Error Handling

Show withdrawn or expired proposals without accepting a new decision. Failed email does not change the quote's recorded terms. Stale responses against replaced pricing fail with the current revision clearly identified.

## Scope and Completion

Complete when a sent price remains stable, an old link cannot accept modified terms, and a matching unverified email account cannot impersonate the recipient. This records a quote decision, not a claim of a regulated electronic-signature product.

A company can accept a two-day office quote, retain its exact price and terms, and receive an explicit booking outcome rather than having acceptance silently overbook the office.

Frontend journey: a verified recipient opens the response link, reads frozen prices/terms and the not-held warning, accepts and sees a separate pending or unavailable booking outcome rather than confirmation.

Frontend journey: sales replaces pricing with a new revision; the old link shows withdrawn state and cannot accept the changed offer. A failed notice/download keeps quote facts intact, and the current revision remains printable under the same recipient policy.

## Composition and Ownership

Recommended placement: Customer and sales. Own sent offer revisions and recipient decisions; reference CanCustomer billing/contact identities and CanRent inventory handoff. Accepted offers cannot be directly edited or treated as confirmed bookings. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.


The offer owner exports Proposal, Revision and Item plus revise/send_offer/document/request_booking for contextual CRM forms. Enabled CRUD follows those exported models; every existing owning salesperson, draft-state, recipient and accepted-booking guard remains unchanged. A Proposal invariant additionally requires its recipient Contact to belong to its Customer parent, preventing mismatched canonical identities from any creation path. Consumers bind canonical customer/contact/location and authored quote inputs rather than copying pricing or permission contracts. A recorded CRM quote identifies one actual issued revision; pending or unavailable inventory handoff is separate from acceptance. The offer/current_offer fixtures are exported solely for inline examples. No generated owning-package JavaScript, document adapter or reservation implementation is supplied here.

## Authored draft workflow

The response route is `/offers/respond/{Revision.id}`. That server-issued opaque record identity locates the revision; its existing verified-recipient read policy and decision guard authorize access. Outbound mail and the copy control use `app_url` with that exact internal path and the trusted configured deployment origin. The URL does not grant decision authority. Composition mounts the owning recipient page alongside CRM without changing its guards.

Revision.snapshot is the single QuoteDocument projection used by document generation, temporary inventory holds and accepted booking requests. It freezes issuer/customer display names, recipient, resource, capacity units, attendees, service interval, line titles/units/quantities/prices/tax/discount, total/currency, terms, refund deadline and quote expiry. The authored refund deadline defaults to service start and can be changed before issue; consumers never infer it by parsing terms or reading a later resource policy. Capacity quantity and attendees are distinct from commercial line quantities. QuoteOffer and AcceptedOffer export the immutable snapshot plus canonical customer/location IDs, opaque revision source and commercial revision number. AcceptedOffer additionally carries the deciding recipient account and decision time. Document/result correlation uses the commercial number, not a mutable record version.

An optional hold calls CanRent with a separate deadline no later than quote expiry. Pending, held, unknown, expired and release-pending states remain distinct. The inventory owner expires capacity at the deadline. Ordinary expiry does not withdraw the quote or fence a timely accepted decision; a subsequent booking still rechecks capacity. Withdrawal/decline requests an idempotent fenced release using the explicit resource reference. An expired/released hold requires a fresh revision to promise a new hold. Acceptance records agreement only. `request_booking` sends the exact accepted snapshot to the canonical reservation owner; committed outcomes retain booking and invoice references. ReservationOfferOutcome distinguishes hold, booking and release outcomes: a delayed hold confirmation can never be mistaken for a booked reservation sharing the same quote source. Its separate owner record version orders updates without changing the frozen commercial revision number. Later canonical cancellation/expiry can update a previously confirmed booking, while older replies cannot restore stale state. Uncertain transport remains unknown until an authoritative result arrives. A pending handoff never represents payment or guaranteed admission.

For an authoritative unavailable booking, the owning salesperson can prepare an alternative revision with a new resource/interval/terms and copied itemized prices. The original accepted facts stay immutable. Sending and a new verified recipient decision are required; accepting the alternative marks the old handoff superseded. An in-flight or confirmed original cannot be silently replaced. Staff and recipient views display the separate held deadline, booking outcome and invoice reference. Email and PDF delivery each retain their own pending/ready-or-delivered/failed/unknown/skipped outcomes; a failed delivery never changes frozen prices or the recorded decision.

Inline examples cover issuing a hold, invalid deadlines, exact accepted handoff, permission rejection and a sold-out alternative retaining its original price. Source parsing checks syntax only; scenario execution, provider binding, quote PDF generation and actual reservation/invoice/payment behavior remain unimplemented contracts.

Daily offers freeze `QuoteInterval[]` service windows on Revision and QuoteDocument. The empty array retains the ordinary continuous hourly interval. Nonempty arrays require positive bounded intervals, distinct starts, pairwise nonoverlap, and exact agreement between their first/last boundaries and the outer from/until; revision creation sorts and locks them. Alternative offers receive their own explicit windows. CanRent requires nonempty intervals for day resources and checks every interval against the published DayCalendar and current capacity. Overnight gaps allocate no capacity. Inline revision examples include valid two-day access, overlapping windows, and mismatched outer dates.

Optional sales attribution uses the same provider-owned Capture as direct purchases. A sent revision may freeze a product code; accepting with a capture requires that code, the canonical customer, the verified deciding account, the quote location and the latest eligible capture. Acceptance freezes code/program/time/window into AcceptedOffer. CanRent checks the declared product against its actual resource kind before creating an attributed booking; a mismatched quote cannot claim a different product’s referral eligibility. Unattributed quotes need no product code. Later booking retries transport the accepted facts without selecting a newer code or restarting its window.
