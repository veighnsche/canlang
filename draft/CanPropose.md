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

For an authoritative unavailable booking, the owning salesperson can prepare an alternative revision with a new resource/interval/terms and copied itemized prices. The original accepted facts stay immutable. Sending and a new verified recipient decision are required; accepting the alternative marks the old handoff superseded. An in-flight or confirmed original cannot be silently replaced. Staff and recipient views display the separate held deadline, booking outcome and invoice reference. Email and PDF requests retain typed delivery associations. Read-only transport projections show pending/succeeded/failed/unknown/skipped, with null meaning not requested. Mail success reports delivery success, not recipient reading or agreement. PDF business outcome separately remains none/pending/ready/failed/unknown/skipped: only the current attempt with matching source identity and commercial revision can attach its finalized file and become ready. Failed, skipped or uncertain regeneration retains any previous PDF. Delivery progress alone changes neither frozen prices, quote decisions nor the domain record version.

Inline examples cover issuing a hold, invalid deadlines, late and older-version results, current-state expiry, stale/repeated deadlines, addressed recovery admission, exact accepted handoff, permission rejection and a sold-out alternative retaining its original price. Source parsing checks syntax only; scenario execution, provider binding, quote PDF generation and actual reservation/invoice/payment behavior remain unimplemented contracts.

Daily offers freeze `QuoteInterval[]` service windows on Revision and QuoteDocument. The empty array retains the ordinary continuous hourly interval. Nonempty arrays require positive bounded intervals, distinct starts, pairwise nonoverlap, and exact agreement between their first/last boundaries and the outer from/until; revision creation sorts and locks them. Alternative offers receive their own explicit windows. CanRent requires nonempty intervals for day resources and checks every interval against the published DayCalendar and current capacity. Overnight gaps allocate no capacity. Inline revision examples include valid two-day access, overlapping windows, and mismatched outer dates.

Optional sales attribution uses the same provider-owned Capture as direct purchases. A sent revision may freeze a product code; accepting with a capture requires that code, the canonical customer, the verified deciding account, the quote location and the latest eligible capture. Acceptance freezes code/program/time/window into AcceptedOffer. CanRent checks the declared product against its actual resource kind before creating an attributed booking; a mismatched quote cannot claim a different product’s referral eligibility. Unattributed quotes need no product code. Later booking retries transport the accepted facts without selecting a newer code or restarting its window.


## Record-addressed hold deadlines and recovery

`Revision.created` and `Revision.updated` load one current revision by the committed `event.id` and emit `HoldProgress`. The expiry/release handler no longer scans all revisions on a minute tick. For pending, held or unknown inventory with a future deadline, it replaces the one `offer-hold:{Revision.id}` schedule with `HoldDeadline {revision,until}`. A deadline records its expected instant, then checks the current held deadline and current hold state before writing. A shorter authoritative hold result updates `held_until`, whose committed event replaces the keyed schedule. An old admitted deadline cannot expire a newer deadline. Released/expired/ineligible progress cancels the pending key; already admitted work still uses its current-state guard.

At the due deadline, an ordinary sent or accepted quote's hold becomes expired. This does not withdraw the quote, invalidate recorded acceptance or send a release against an accepted booking. The inventory authority's own deadline releases held capacity, and booking continues to recheck it. Withdrawal/decline instead enters releasing; current progress sends one fenced release with the explicit resource and records its delivery. Later progress cannot send a second release while that reference exists. A late hold callback cannot change a releasing or expired hold back to held. Failed/uncertain release remains visible and `retry_hold_release` explicitly clears the recorded reference, whose committed change restarts follow-up. Current booking-kind/version guards continue to separate a hold from an accepted booking.

A revision held before this migration may lack a scheduled occurrence or a new committed change. The existing Offers action list now exposes `recover_hold(revision)` to the owning salesperson with the existing location grant. Ordinary expected-version admission rejects stale input and the shared receipt handles request replay. This action emits the same record-addressed progress, installs any future deadline, expires any already-due hold, or resumes an unsent release according to current state. It neither extends the deadline nor resets an uncertain release. Operators select older backlog from the existing revision list; there is no invented global recovery scan.

The remaining `limit=100` loops withdraw undecided revisions under one Proposal or copy items under one Revision. They bound indivisible local work and fail without partial changes when oversized. They are separate from independent revisions' background progression; the committed-event identity lookups each use `limit=1` because they locate one immutable record ID.

Manual source trace, conditional on the unimplemented durable committed-event/schedule runtime:

| Independent holds needing follow-up | Addressed progress and future deadlines | Behavior at the former scan boundary |
| --- | --- | --- |
| 99 | 99 independent HoldProgress admissions; at most one deadline per revision | Each reconciles one revision |
| 100 | 100 independent HoldProgress admissions; at most one deadline per revision | Same path; no batch boundary |
| 101 | 101 independent HoldProgress admissions; at most one deadline per revision | The 101st owns separate work and cannot roll back the preceding 100 |
| 1000 | 1000 independent HoldProgress admissions; at most one deadline per revision | The same finite path repeats; no app-authored tenant/population loop |

Due deadlines, release replies and accepted-booking changes can produce further independent occurrences. Old records enter this trace after one authorized recovery admission per record. Runtime admission can defer excess total load, and oversized local atomic authoring operations can still fail; the draft does not claim unlimited effects or solve progress by raising a limit. These are manual expectations, not executed concurrency, scheduler fairness or journey results. No CanPropose MJS implementation is added.

## Typed mail and document associations

`Revision.notice` and `Revision.document` use the existing bound Mail.send and Documents.quote targets. There is no stored notice ID or transport-state mirror and no notice-copy callback. The PDF completion handler remains necessary to validate the current attempt, source and commercial revision before attaching the result; transport success with mismatched business correlation remains a visible succeeded delivery and unknown document outcome. Replacing a document request selects the current attempt without cancelling an earlier one. An older completion cannot overwrite it. Existing salesperson/location and verified-recipient grants, frozen snapshot/price locks, decision guards, booking handoffs and page bindings are retained. Staff and recipient document views show both transport and business outcomes.

The focused [source/JavaScript correspondence note](../design/propose-delivery-20261004.md) includes a clearly partial desired target, not a new app implementation. Two source tables contain 21 cases covering all five mail transport states, no request, document success/correlation errors/failed/unknown/skipped completion, superseded attempts, preserved previous files and quote facts, caller rejection and stale record input. Their typed delivery recipes contain complete requests and consistent status/result/error shapes. Finalized test-file recipes do not generate PDF bytes. One five-statement sequence makes two actual document calls and checks distinct current request identities and domain versions; it does not execute provider completion.

Verification compares all 21 source input/expected/error tuples with the partial target and confirms 15 other scenario bodies plus policies, invariants, locks and the frozen snapshot are unchanged. The excerpt passes Node syntax checking and its fixture descriptors construct with complete dependency references. The current syntax parser rejects delivery(Target), and attached sequences are also unsupported; a temporary projection replacing only those two field types with text and omitting the new sequence parses the surrounding declarations/tables. No symbol/type validation, business execution, privacy enforcement, provider delivery, receiving-file finalization or full CanPropose generated target is verified. These remain proposed shared compiler/runtime/adapter contracts.


Delivery fixture normalization reduces twelve complete receipt declarations to three: one varying Mail attempt and two independently identified document attempts. The second document ID is essential for the superseded-result row even though both requests have equal inputs. Initial whole status/result/error cells replace per-outcome recipes without changing the frozen normalized request, QuotePdf result type, file provenance or source/revision business checks. All 21 affected rows keep their exact independent expected values/errors, including wrong-source/wrong-number successful transport, old current ID, preserved original PDF and quote decisions. Event and recipe envelopes remain explicitly repeated cells; no generic structural fixture-value or event-from-receipt syntax is added.

The unchanged `current_offer` baseline has null receipt associations. Each document recipe explicitly depends on `priced_item` before freezing `current_offer.snapshot`; a later current-document association override introduces no declaration cycle. The common successful callback event already references `generated_pdf`, so that file remains a common baseline dependency even for rows replacing the final result with null. Its existing receiving-result provenance requirements remain mandatory and unexecuted.

Against the captured source immediately before normalization, Can source changes from 42,241 to 41,010 UTF-8 bytes (1,042 fewer). Production source after test erasure and the partial JavaScript production prefix are byte-identical. All 64 app-table expectations are unchanged; the 21 affected rows correspond to the partial target, which remains a partial excerpt with no app MJS added. Node syntax, declared/imported fixture dependencies and direct-selector closure checks pass. These checks execute no application, provider or file finalization.

## Terminal prebooking rejection and explicit alternatives

`request_booking` admits only a revision with no prior handoff. A definitive prebooking capacity rejection is an authoritative unavailable outcome backed by the reservation owner's locked exact-request fence. The old accepted revision cannot later become a booking: the existing `offer_alternative` action creates a fresh revision, copies its itemized prices, and requires sending and a new recipient decision. It may use the same resource; neither the old accepted amount nor terms are rewritten. Failed or unknown transport still remains unknown and cannot enable that alternative. Matching domain outcomes retain the existing commercial revision and per-kind owner-version checks.

Automatic alternative preparation additionally requires no recorded Booking reference. An unavailable committed booking may still have money or cleanup work; its reference and invoice remain displayed, with instructions to use the Workspace cancellation/reconciliation/refund workflow. Ordinary `revise` can prepare a separately reviewed new offer, but that operation does not cancel or supersede the existing booking's obligations. Staff and recipient views distinguish this case from a prebooking rejection. The original accepted evidence and invoice/booking history remain retained.

The reservation owner checks for an existing same-source Booking before any release/rejection fence outcome. A late duplicate acceptance after booking and quote release therefore cannot publish unavailable/no-reference version 1 and suppress the real Booking's pending/version 1 event. The consumer retains unknown after the failed duplicate and can accept the matching later Booking outcome. Added isolated tables cover this ordering, terminal unavailable and unknown re-request rejection, older outcomes, same-resource fresh alternatives and refusal to replace an existing booking. Static syntax projection succeeds after removing only the existing unsupported delivery-type spellings and one pre-existing sequence-example suite; the new tables remain in that projection. The unmodified source still exceeds the current parser, and no business example or provider lifecycle was executed. No full CanPropose MJS target exists; the existing partial delivery excerpt does not cover these booking operations and remains unchanged.
