# CanMail requirements

Inherits [canlang requirements](../REQUIREMENTS.md), [workspace operator context](WORKSPACE_OPERATOR.md), and [portfolio composition](PORTFOLIO.md). The authored contract is [CanMail.can](CanMail.can); [CanMail.mjs](CanMail.mjs) is its handwritten desired JavaScript target, with proposed unimplemented imports.

## Purpose and Adoption Goal

Optionally help a workspace operator receive and deliver customer mail/parcels for on-site or virtual-office customers. Adoption depends on knowing what arrived, notifying the authorized recipient, and retaining collection or forwarding evidence.

## Users and Permissions

Authorized location mail staff record receipts and handling. Verified recipients see only items linked to their own contact or organization mail role. Organization administrators grant collection delegates explicitly. A booking, company email domain, or login alone does not authorize collection, opening, or forwarding.

## Data and Ownership

Mail service entitlement records customer, location, active period, permitted handling, and recorded recipient instructions/version. An item has stable receipt identity, recipient/service reference, receipt time, type, safe storage reference, optional bounded receipt photo, and received/notified/collection_ready/collected/forward_pending/forwarded/returned state. Retain collection delegate/actor/time or dispatch/carrier reference, fees/currency, and immutable handling history. Default identifiable item-history retention is 180 days after completion, with developer-maintained retention configuration outside the product UI.

## Workflows and Business Rules

Validate the active service and recipient before accepting an item into a customer queue; unmatched items enter restricted staff review. Notification is not collection. Staff record collection by an authorized recipient/delegate once with evidence. Forwarding uses snapshotted explicit instructions and destination; changing a contact address cannot redirect an already dispatched item. A failed or uncertain dispatch remains pending until evidenced.

Service expiry stops new handling entitlements but existing items remain available for an explicitly recorded collection/return resolution. Never discard or return an item merely because a timer or membership callback fired. Reversals/corrections append handling history. Initial scope is receive, notify, collect, forward, and return; opening/scanning mail content and call answering are deferred.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). When mail handling is offered, order navigation as My mail for verified permitted recipients, then Mail and parcels for location mail staff. Incoming, unmatched, uncollected and forwarding queues belong within the staff index; individual item/history views are contextual links. Delegate actions retain own-company authority.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| My mail — recipient index | Item Cards with receipt/type/state Badge and authorized handling history; service location/period/instructions List | Read only linked own items; manage authorized recipient instructions and nominate collection delegates through the owning workflows |
| Mail and parcels — location staff index | Location/status Select filters, queue Tabs and receipt Fieldset; Item Table with restricted physical-storage reference and incident Alert | Receive/match against current entitlement and recipient; record notification separately from physical collection |
| Collection detail — contextual permitted view | Recipient/delegate verification, instruction version, receipt/photo state and attributed collection evidence | Collect once only for the currently authorized recipient/delegate; expired service leaves existing items for explicit collection/return resolution |
| Forwarding/return — staff queue/detail | Snapshotted destination, carrier/evidence, recorded forwarding fee/currency and pending delivery Badge; handling history List | Forward, evidence dispatch, return or append corrections under current grants; invoice settlement cannot certify delivery |

On reception devices, place verification beside the intended action; stack mobile labels without exposing storage to recipients. Distinguish loading, no own items and filtered-empty queues. Preserve receipt/handling input after validation, stale dispatch or interrupted optional photo upload. Failed notices, lost-item incidents and uncertain forwarding remain visible for staff resolution. Retried collection, fees and dispatch retain their logical identity rather than duplicating handling. A changed contact cannot redirect a frozen dispatch, and expiry must not silently discard or return unresolved physical mail. Exclude technical retention/carrier/retry settings and opening/scanning contents.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Recipients may remember their own-item history/status view; staff may save an authorized location and queue filter. Clear/reset restores accessible defaults; discard revoked scopes. Personal settings cannot grant delegate rights, redirect forwarding, set service entitlement or change retention. Forwarding instructions and delegate nomination are explicit authorized business actions on the service/item views, rather than unchecked preference toggles.

## Interfaces and Integrations

Use D1, R2 for bounded receipt photos, and EmailService. CanMember or a configured service record owns the paid mail entitlement; CanCustomer owns customer/delegate identity. Declare unique same-currency fee charges to CanInvoice if enabled; a forwarded state requires dispatch evidence, not invoice settlement. A carrier adapter is optional; manual carrier evidence remains usable.

Retention, delivery retry defaults and carrier/provider wiring are developer maintenance. Staff/recipients manage actual item handling and their authorized forwarding instructions in ordinary pages, with no technical policy editor.

## Background Actions

Notify verified recipients after durable receipt and send bounded uncollected-item reminders under the configured policy. Re-check delegate/service state before new handling and retry delivery or forwarding work with stable identities. Expire permitted personal history without deleting unresolved physical-item records.

## Error Handling

Reject unauthorized delegate collection, conflicting receipt identities, mismatched recipient/location, invalid destinations, and stale dispatch actions. Retrying collection or fee creation cannot duplicate either. Show failed notification, lost-item incidents, and uncertain forwarding for staff resolution without pretending the item reached its destination.

## Scope and Completion

Enable only when the operator offers mail handling or virtual-office service. A customer can see an arrived parcel, nominate a permitted collector, and retrieve collection evidence; staff can forward another item once to its authorized snapshotted destination. No room booking is implied by a mail-service entitlement.

Frontend journey: a recipient opens an arrived parcel, nominates a permitted collector and later reads collection evidence; staff verifies the current delegate before collection, and repeating the action does not create another receipt or fee.

Frontend journey: staff records forwarding to the frozen destination and sees uncertain delivery as pending even after billing settlement. A later contact edit leaves that destination intact; an expired service still offers explicit authorized resolution for existing items.

## Composition and Ownership

Optional distinct mail-handling app/package. Reuse customer identities, service entitlements, and billing rather than duplicating them. It is not required to deploy the short-rental booking flow.

## Authored draft completion

The source now declares staff service setup and availability review, current paid-service admission, recipient instruction updates with revision checks, verified delegate nomination, durable receipt/matching, actual EmailV1 acceptance outcomes, collection, frozen forwarding attempts, uncertain dispatch, evidenced dispatch/return, appended corrections, and same-source fee invoice recovery. My mail includes permitted handling evidence; the staff index retains private storage and photo fields. Instruction and dispatch forms bind the current business revision explicitly.

A membership-backed service references the actual exported `member_terms.Term`. New receipt, matching and forwarding require the purchased `Term.mail` benefit, its location and currency, and `eligible_term` at admission. This uses the provider's live paid, pause/revocation, current customer role and assigned-seat checks. No mail entitlement feed or automatic subscription is assumed. A configured standalone service instead requires staff-recorded paid evidence and an active period; a denied linked term cannot fall back to that evidence. Held items still support current verified recipient/delegate collection or staff-evidenced return after service expiry. Organization delegate grants require its administrator; an individual owner may grant delegates. Current verified customer identity is checked again at collection.

`Dispatch` is an Item child with locked source, instruction version, destination, fee and complete optional `invoice.Charge`. Staff verifies the postal destination explicitly before preparing it. Manual carrier evidence is the supported initial transport path; no carrier lookup, automatic dispatch or postal-address validation API is claimed. Dispatch and uncertain-result forms act on the exact current attempt and revision. Successful dispatch appends immutable Handling with that snapshot; uncertainty leaves the physical state pending. Invoice completion/reconciliation correlates to the latest delivery and the same frozen billing source; fee results never change physical handling state. Billing recovery discards the preceding delivery correlation before requesting reconciliation, and a missing invoice reuses the identical Charge. Returning a pending attempt requires explicit no-dispatch evidence; commercial adjustments remain with the invoice owner.

A keyed reminder checks the still-uncollected item and current verified recipient, sends at most two reminders seven days apart by default, and does not require extending an expired service merely to collect held property. Duplicate/stale reminder numbers do no new work. Collection, forwarding preparation and return cancel further collection reminders. Notice enqueue state is pending; only a correlated successful EmailV1 completion marks a received item notified. Provider acceptance does not establish reading or physical collection, and failed/unknown notices remain visible.

Developer-maintained Item defaults set the reminder policy and `history_days=180`; no product operation edits these settings. Explicit collection, evidenced forwarding or return stores `retention_until=now+history_days*1d`, and `retain Item` applies that deadline to its contained Handling/Dispatch records, history and photo visibility. Unresolved items have a null deadline. Runtime retention must still implement expiry, reference-blocked disposal, replay metadata, outbox/content copies and attachment cleanup as specified in DESIGN §7.1; the declaration is not an erasure implementation.

Inline BDD tables and their deferred JavaScript recipes cover instruction conflicts, delegate authorization and verified identity, denied paid mail benefit, linked-term payment failure without standalone fallback, collection after expiry, repeated collection, invalid/unreviewed forwarding destinations, stale dispatch revisions, frozen destinations after edits, fee settlement while dispatch remains unknown, bounded/stale reminders, notice failures/correlation and explicit return retention. Source parsing and JavaScript syntax checks were run; no examples or application workflows execute because the compiler, semantic checker, stdlib, owner modules, UI, transports and example runner remain unimplemented.

The declared `deployment.mail` and `deployment.billing` bindings must be configured under the current integration contract. `Service.billing=false` suppresses fee sends; it does not invent an optional-binding or conditional-linkage facility. Receipt photos inherit the shared bounded file policy, and ordinary canonical forms/queries retain their shared upload, permission, loading, error and retry contracts.

The three freshly worded JEV consultations are retained in [mail-completion evidence](../design/jev/mail-completion-20261004/). They agree on live Term checks and a separate Dispatch model, with the original confidence/probabilities preserved. Their agreement is design advice, not proof of correctness.
