# CanEvent requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanEvent.can](CanEvent.can).

## Purpose and Adoption Goal

Help workspace community teams sell or allocate places at networking sessions, workshops, and customer events. Adoption depends on customer registration, trustworthy event capacity, and straightforward reception check-in.

## Users and Permissions

Require team authentication for event management. Organizers register attendees on their behalf, and admission staff check in confirmed free or fulfilled paid registrations. Verified attendees register themselves and access their own tickets. Personal customer owners use their authorized invoice destination; company collection goes to the approved customer billing contact, while its booker/administrator attendee sees ticket status and waits for actual settlement.

Add a published event page and verified attendee self-registration and own-ticket access. Staff can register attendees on their behalf. Public visitors never see the attendee roster.

Event organizers author/publish events and their ticket terms in the ordinary event workspace. Reception check-in grants do not include pricing/publication or finance refund authority. These are operational roles, not a separate application-admin side.

## Data and Ownership

Each event has a name and recorded cancellation/refund policy; registrations identify guest and contact email. Events store timezone, start, capacity, ticket price/currency, and sales cutoff. Registrations snapshot ticket price, hold expiry, payment identity/outcome, opaque ticket code, and check-in actor/time. A person may legitimately purchase multiple tickets; submission identity prevents accidental duplication.

Record location, event description, organizer, publication state, venue reference, and optional free-ticket price. Retain attendee cancellations and event cancellation/rescheduling history.

## Workflows and Business Rules

Unpaid registrations hold capacity for 15 minutes. Confirmation/expiry use the same capacity authority. Only confirmed free registrations or fulfilled paid tickets can check in, once. Cancellation/void invalidates the ticket and applies the recorded refund policy. Changing event price does not reprice held or paid tickets.

Zero-price registration confirms a place without fabricating a payment. Event admission capacity is distinct from the venue booking; publication requires a confirmed CanRent venue reservation where the venue is rentable. Block sales for a cancelled event and give affected attendees explicit cancellation/refund outcomes.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Declared sidebar pages are Events (`/events`) for discovery/own tickets and Event operations (`/events/work`) for organizers/reception. Event, ticket, check-in and permitted finance details stay contextual. Use daisyUI; publication/admission remain ordinary operational work.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Published events | Location/date filters, search Input and event Cards with local time/timezone, venue, description, price/currency and sales cutoff. | Public visitors see published offerings and recorded cancellation/refund terms, never the attendee roster. |
| Registration and own tickets | Registration Fieldset and terms Alert; own-ticket Cards with ticket destination/code, hold expiry, payment/fulfillment and admission Badges; cancel Button. | Existing registration/cancellation operations enforce capacity and own-ticket access. Free places confirm without payment; paid holds expire after 15 minutes. |
| Event authoring | Organizer Fieldsets for description, location/time, capacity, ticket terms and publication state; venue reservation Card and attendee-notice outcomes. | Publish/cancel through owning operations; rentable venues require confirmed CanRent reservation. Price changes preserve held/paid ticket snapshots; cancelled events block sales. |
| Reception and payment review | Ticket search Input, focused admission Card and scoped registration Table; separate payment/refund Alerts and outcome references. | Staff register on behalf; check-in grants admit confirmed free/fulfilled paid tickets once. Pricing/publication and finance refund rights remain separate; released capacity does not mean a provider refund succeeded. |

Show held, paid, expired, cancelled and payment-needs-resolution as distinct states. Pending payment/registration retains submission identity; timeout remains uncertain. A late successful payment without capacity displays refund/resolution instead of admission. A previously dispatched collection cancellation, a cancelled ticket, unresolved collection/refund, or a void invoice also blocks late admission. Expired holds cease consuming places at their stored expiry even when timer delivery is delayed. Duplicate scans show already admitted with time. Preserve unsaved authoring fields after errors; a venue/capacity conflict retains current inputs and authoritative outcome. Empty results are explicit. Mobile admission puts lookup and admission result first; event Cards and registration fields stack with cutoff and local time visible. Cancellation or material changes retain notice-delivery outcomes separately from event status.

## Personal Configuration

Inherit shared base settings through the own-user dialog. Remember location/date discovery filters and a personal preference for upcoming versus past own tickets. These settings affect presentation only, never ticket price, capacity, event timezone, publication, refund policy or reception authority. No extra settings console is needed.

## Interfaces and Integrations

Keep events, ticket capacity, current worker/customer eligibility and the related progress records at the default D1 authority, using DESIGN’s proposed revision fence. An Event-only Durable Object is not required: it would separate `can_work` and customer grants from admission without a specified snapshot/revocation protocol. CanRent owns venue capacity; CanInvoice owns collection and refunds through its payment adapter. Email uses the existing `std.EmailV1` contract.

Declare venue reservation and payment/refund capabilities. An event cannot create a second independent room-availability ledger.

In the composed profile route ticket charges to CanInvoice as the one collection owner, preserving registration/ticket source identity; standalone direct collection must not run alongside it. If attendee admission is linked to CanReception, expose only the scoped confirmed admission/host evidence, not a writable room-occupancy flag.

## Background Actions

Expire unpaid holds and send confirmations after capacity and payment are reconciled. A late successful payment attempts to regain capacity; if unavailable, mark it for refund/resolution rather than overselling or hiding received money.

Notify registered attendees of cancellation or a material schedule/location change using the current revision and retain delivery outcomes.

## Error Handling

Repeated provider events and scans cannot create duplicate admission. Payment timeout remains uncertain until reconciled. A cancellation racing settlement preserves the money event and prevents admission until its outcome is resolved.

## Scope and Completion

Complete when two buyers cannot get the last place, abandoned holds expire, duplicate scans count once, and payment after hold expiry has a visible fulfillment/refund outcome. Initial refunds are full-ticket refunds; released capacity and provider refund status remain distinct.

A member can register for a free or paid workshop, receive their own ticket, and check in once while the workshop's venue remains unavailable for competing workspace sales.

Frontend completion additionally requires these journeys:

- An attendee finds a free or paid workshop, reviews its policy, receives their own confirmed ticket and is admitted once without seeing the roster or acquiring venue-management rights.
- Two competing last-place requests produce one confirmation; a late payment after hold expiry shows its fulfillment/refund outcome, and reception cannot admit an unresolved/cancelled ticket.

## Composition and Ownership

Recommended placement: Community event module. Own event publication and attendee/ticket capacity. CanRent owns its venue and CanReception may reference confirmed attendees for visitor handling. Event admission remains distinct from guest departure or room clearance. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.


## Authored completion and binding contract

`CanEvent` selects the existing `events` and `invoice` packages. The invoice pages, customer billing permissions and payment operations remain canonical; adding an attendee never grants company invoice or checkout access. Staff enter the same `register` operation with an explicit account and contact email under the organizer location grant. Self service defaults the address to verified `actor.email`; paid registration checks the selected subject’s current individual ownership or location booker/administrator grant. Ticket price, original billing location, terms and refund cutoff are immutable snapshots. Multiple intentional tickets use distinct submission identities.

`change` captures location, schedule, timezone, capacity, sales cutoff and reason in a `Change` record. A same-resource replacement calls `RoomsV1.stage` with the confirmed predecessor’s owner revision and its unchanged customer/account/quantity; a different resource calls `hold` with a fresh source. Both use `price=null`, `terms=null` and quantity one: they are venue allocation, not a fabricated zero-price sale. Current room attendee limits bound the requested event capacity. A separately committed `confirm` result makes the candidate eligible for adoption. Adoption rechecks event revision, live ticket capacity, future start, no completed scans, and the proposer’s current organizer/worker grants at both locations. Failed or uncertain candidates retain the selected event and predecessor. Successful adoption switches the event before requesting predecessor release; release failure leaves visible cleanup state rather than rolling back a committed replacement.

Every room completion first matches its stored delivery, then source; verified changed events match source and accept only increasing owner revisions. The selected pending change, material revision and release state fence late candidates. Abandonment clears selection and releases the captured resource/source even before a hold arrives, relying on CanRent’s explicit release tombstone. Cleanup retries repeat the frozen source/resource/reason, including an uncertain release, because release is a source-fencing operation. No room availability mirror or second occupancy ledger is created.

| Bound operation | Existing owner mapping and Event handling |
| --- | --- |
| `Rooms.hold`, `Rooms.stage`, `Rooms.confirm`, `Rooms.release` | CanRent `RoomsIngressV1` matching event commits `VenueOutcome`; the adapter completes only that originating delivery. Event stores each delivery status and processes its correlated `OperationOutcome`. `Rooms.changed` forwards committed venue revisions. |
| `Billing.charge` | CanInvoice `BillingRequests.charge` commits `ChargeOutcome`; it issues the frozen source invoice and sends its canonical destination to the approved payer. Event stores the protected `delivery(Billing.charge)` association, derives `charge_status` from its receipt status, correlates completion by the current association ID and source, and requests settlement reconciliation. A later delivery result does not downgrade an already settled ticket. Ticket fulfillment uses `Billing.settled` or correlated reconciliation, never invoice issuance or delivery success. |
| `Billing.cancel` | `BillingRequests.cancel` commits `BillingCancellation` and `CancelOutcome`. Event records the fence revision and authoritative absent-source result separately from collected/refunded money. Repeating a failed/unknown cancellation uses the first captured reason. |
| `Billing.refund` | `BillingRequests.refund` commits `RefundOutcome`; refund delivery remains separate from cumulative refunded evidence. The outstanding evidenced amount is sent only after cancellation acknowledgement, at least its fence revision, and cleared collection/refund uncertainty. |
| `Billing.reconcile` | `BillingRequests.reconcile` returns the owner `Settlement?`. Delivery correlation and source/amount/currency checks feed the same revision reducer as `Billing.settled`. Null is not proof that collection stopped. |
| `Mail.send` | Existing `std.EmailV1` completion updates its own receipt. Each `Notice` row stores the protected `delivery(Mail.send)` association and derives `state` from its receipt status, replacing the stored delivery ID, status mirror and acceptance-reference copy. Both organizer and attendee readers receive only the `delivery.id`/`delivery.status` leaves plus the derived state, never result or error contents. A successful receipt does not prove reading. The pure receipt-copy callback is removed with no business transition lost. Retries create a new notice row with its own association, preserving earlier attempts. |

Event cancellation immediately fences sales and admission. Keyed `AttendeeUpdate` and `VenueCleanup` occurrences process one remaining record per transaction, saving progress and scheduling the next occurrence through existing primitives. This avoids making cancellation or material changes fail merely because registration/change history exceeds a 500-item loop bound. A newer event revision replaces pending attendee work; stale admitted occurrences cannot apply their older revision. The ticket page displays parent cancellation alongside individual processing/refund outcomes while background work advances.

A full-ticket refund request returns the actual outstanding collected balance. A refund’s captured cumulative target prevents another request while the first is unresolved; further evidenced funds can be returned after the earlier target has actually been refunded. The `refunded` refund outcome means the fenced source has no unsettled balance, including an authoritative absent invoice or a void invoice with zero funds. Full cancellation of ticket admission does not itself claim a provider refund. Finance may authorize resolution of expired/cancelled/review tickets under current event and original billing-location scope; check-in has neither that operation nor financial-detail fields.

Registration creation explicitly snapshots the original event location for collection and later finance authorization, alongside the already frozen ticket terms and price. Invoice-request delivery status is visible on own tickets and authorized finance details. A skipped refund request returns to review and rechecks the existing cancellation fence, cumulative balance and uncertainty gates before retrying; unknown delivery is not retried as though it had been skipped. When fenced settlement evidence resolves all collected funds, payment displays refunded even if only part of the ticket price was collected; a void/absent source with no collected funds displays unpaid. Neither case restores admission.

The invoice-request association replaces only the raw charge delivery ID and its redundant stored status. Both own-ticket and eligible organizer/finance read grants explicitly retain every previous ordinary Registration field and safe metadata, with only `delivery.id` and `delivery.status` selected from the new typed receipt; neither grant exposes `delivery.result` or `delivery.error`. Admission staff keep their existing limited field grant. Finance renders `row.delivery?.id` to preserve the prior delivery-reference display, and both ticket views use the nullable derived status with explicit English/Dutch labels for pending, succeeded, failed, unknown and skipped. `charged_money` keeps its invoice-reference, uncertain-payment and reconciliation reactions without writing receipt status into the business record. Runtime receipt changes alone do not advance Registration version or run its hooks. Venue, cancellation, refund and reconciliation receipt representations remain outside this focused migration; the attendee-notice representation now uses the same association form (see the `Mail.send` row above).

Revision-bound notices include event name, location, recorded start/end, event timezone, revision, ticket identity and the authored change/cancellation reason. Dispatch guards suppress undispatched stale notices and invalid confirmation; already accepted mail may still arrive. Mail failure, unknown acceptance and skipped sends stay visible through the derived receipt state, independently of event status. Resend still requires the current revision and a failed/unknown observed state, and each retry is a new row with its own receipt. The shared runtime still owns outbox retries, receipt history and canonical delivery recovery.

Inline examples now cover verified own/free registration, scoped staff paid/free registration, last-place denial, duplicate scans, staged change and original preservation on provider failure, abandoned and obsolete venue results, mismatched delivery/source, current versus stale adoption, revoked proposer scope, cancellation progress, late-money capacity recovery, capacity exhaustion, cancellation fences, pending refunds, stale settlement revisions, amount mismatch, refund-fence/uncertainty gating, and attendee-notice dispatch, skipped invalid confirmation and stale-revision rejection. They specify expected behavior without dispatching live providers.

The focused correction examples additionally observe the original billing location, correlated invoice issuance without fulfillment, uncertain or unrelated invoice completions, preservation of already paid tickets, mismatched invoice sources, skipped versus unknown refund delivery, partial-payment refund completion and zero-funds void resolution. Charge completion rows now use protected `Billing.charge` fixture recipes with all ten `Charge` fields supplied, including the frozen paid amount, original location, source, customer, description, local due date and nullable issuer/terms/items/consent. Their source and terms are the known frozen ticket constants, with location from the shared site fixture; neither recipe depends on Registration, so selecting it into Registration cannot introduce a recipe/record dependency cycle. Their request is normalized against the untouched baseline, before model overrides; the fixed EUR 10 amount intentionally matches every paid callback row. Direct recipe status/result/error setup selectors agree with the completion envelope, without writing a published receipt. A callback for an unassociated attempt leaves the current pending receipt and ticket unchanged. Failed and skipped requests also specify uncertainty/reconciliation, while failed delivery cannot downgrade an already paid ticket. These are inline specifications; they have not been executed by an example runner.

Three independently reworded JEV requests and responses are retained in [event consultation evidence](../design/jev/event-completion-20261004/). All chose staged D1, but the fence-property estimates were 0.66, 0.70 and 0.30. The disagreement prompted explicit candidate-selection/source/revision fences, terminal ticket checks and separate cleanup/cancellation outcomes. Those judgments are advice, not execution evidence or approval to replace business requirements.

The current parser rejects the canonical `delivery(Billing.charge)?` and `delivery(Mail.send)` field types because it does not yet parse delivery associations. It also rejects the canonical structured enum label on the charge derive. An in-memory syntax projection replacing the delivery types with `text?` and `text` and only that structured label with its scalar caption parses the remaining source and tables; this is a disclosed syntax check, not equivalent source, receipt typing or label-rendering evidence. The notice derive carries no label, matching its unlabeled stored predecessor, so only the charge derive label is projected. All five charge-status values retain explicit English/Dutch labels in the actual source. Static checks cover field-grant preservation, canonical Charge request keys, table arities and unchanged business-handler ordering. No JavaScript target exists for Event and none was added. The desired lowering uses the canonical `delivery(c,{record:row,field:"delivery"},["status"])` observation for the derive and `["id"]` for stored ID reads, never a raw-handle lookup. No symbol/type checker, inline example runner, D1 concurrency test, provider adapter, compiler, renderer or deployment was executed or implemented. The bindings above are proposed contracts with actual declared provider ingress/outcomes; installation still requires their explicit authenticated operation/delivery/commit mappings under DESIGN §8.
