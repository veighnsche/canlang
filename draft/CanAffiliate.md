# CanAffiliate requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanAffiliate.can](CanAffiliate.can).

## Purpose and Adoption Goal

Help the workspace operator pay brokers, relocation agencies, and commercial partners for qualifying workspace sales. Adoption depends on tracing each commission to a real booking or membership sale and understanding when funds reached the partner.

## Users and Permissions

Partner managers maintain partner records and rates. Authorized finance members request settlements; source integrations submit sales through scoped server credentials. Partners control their provider onboarding details through the provider flow rather than editable banking fields in this app.

Partner managers work across their granted locations; finance controls settlements. A verified partner portal exposes only that partner's terms, attributed sales, commission adjustments, and settlement history, without other customers' personal details.

## Data and Ownership

Partner stores name, contact email, configured rate, and provider account reference. Sales snapshot commission rate, currency, attributed partner, and source sale ID. Commission adjustments record refunds/reversals. Settlements have stable operation IDs and separate platform-transfer and bank-payout references/states. Future rate changes do not recalculate old commissions.

Record partner type, applicable locations/products, commission agreement version, qualification date, and the originating booking or membership reference. Each sale records the booking location and billable customer organization. Qualification must be supported by payment and cancellation evidence from the source.

## Workflows and Business Rules

Reserve commission atomically before settlement. Refunds adjust commission even when it has already been paid, potentially creating a balance owed; block new settlements while funds are insufficient. Release a reservation only after confirmed failure before allocation or confirmed reversal. Failure of a bank payout after funds reached a connected account must not credit the commission a second time.

The configured agreement states whether commission qualifies on confirmed payment, completed use, or another recorded milestone, and how refunds affect it. Distinguish an ordinary member referral managed in CanRefer from a contracted broker commission; an explicit sale rule prevents an unintended reward in both programs.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Declared sidebar pages are Partners (`/partners`) for managers/finance and My commissions (`/partners/mine`) for verified partners. Sale, adjustment and settlement details open contextually within them. Use daisyUI; this ordinary partner/finance workspace needs no extra administration area.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| Partners | Search Input and active/period/currency Select filters above a paginated Table of partner name, agreement, rate, onboarding and scoped balances; an edit suite with textarea agreement, range rate, radio milestone and checkbox active edits partner terms, and the create form carries the first three (active is not a create input). | Existing partner create/edit operations require manager authority; show agreement qualification milestones and frozen historical rates. |
| Sale and adjustment detail | Card header with source booking/membership reference and qualification evidence; Tables show sales and refund/reversal adjustments with dates and currency amounts. Reversed renders as status; frozen evidence uses collapse (same disclosure contract as details); tables carry Pagination. | Open authorized source records; future rate edits never reprice this history. |
| Settlement review | Badge allocation/bank, status review, a collapse for settlement identity, and a gated alert (shown only when review is set or allocation is unknown) carrying the delivery reference; settlement opens in a modal dialog via button opens=; available funds render as a slotted stat of the owned available() derive (single-currency display); tables carry Pagination. | Finance requests settlement through the owning operation only; funds and provider eligibility remain server checked. Provider onboarding uses the provider flow rather than banking fields. |
| My commissions | Readable agreement Card, own-sale and settlement Tables, period/currency filters, and a share-link copy control. Status onboarded, badge provider_state, captioned link to the provider onboarding URL (rendered only when the link is non-null and unexpired), direct button action= for onboarding/refresh/settlement-refresh, and the same available-funds stat; lists carry Pagination. | Verified partners see only their own terms, adjustments and statement, without other customers' personal details. |

Keep allocated funds visually separate from bank receipt, even when one stage succeeds and another fails. A pending request disables repeated submission and retains its operation reference; timeout remains uncertain. Show empty statements and unavailable funds explicitly. Preserve unsaved manager edits after validation errors and confirm discard before navigation. On narrow screens stack balance Stat cards and use labeled sale/settlement Lists while keeping status and currency visible; do not total unlike currencies. No countdown is authored: remaining time to onboarding expiry is not a stored readable duration, and date arithmetic is not invented in presentation.

## Personal Configuration

Inherit the shared own-user settings dialog and its base settings. Offer only a personal default commission period and compact/comfortable ledger presentation, scoped to the current user's permitted partner view. These preferences affect display, never agreement rates, provider onboarding, qualification rules or settlement authority. There is no app-specific administration/settings landing page.

## Interfaces and Integrations

Use D1 for the commission ledger and authenticated sale/refund ingestion. Stripe settlement requires a funded provider balance and eligible onboarded connected accounts; a sale ledger does not itself fund a transfer. The adapter distinguishes [connected-account transfers and bank payout lifecycle](https://docs.stripe.com/connect/payouts-connected-accounts), exposing only the operations this app needs.

Declare sale qualification/reversal ingestion from booking or membership billing and expose settlement outcomes. A source reference is not proof of qualification or funding.

## Background Actions

Process settlements with the same provider operation identity on retry. Reconcile pending, in-transit, succeeded, returned, and failed outcomes from provider events. A timeout remains uncertain; bank arrival is not immediate on transfer creation.

## Error Handling

Reject conflicting sale IDs, unsupported currencies, or insufficient commission/provider funds. Unknown provider outcomes keep funds reserved. Show onboarding/action-required failures; releasing funds requires confirmed evidence, not a retry counter expiring.

## Scope and Completion

Complete when changing rates leaves history intact, concurrent settlement requests cannot spend the same commission, and timeout or bank failure cannot create a duplicate payment.

A broker can trace a qualifying office booking through its frozen commission, later refund adjustment, and provider-confirmed settlement without seeing another broker's records.

Frontend completion additionally requires these journeys:

- Finance opens a qualifying sale, checks its frozen rate and later refund adjustment, requests settlement, and can distinguish reserved commission, provider allocation and confirmed bank delivery through a timeout.
- A verified partner downloads their statement and follows its settlement references while another partner's sales and customer details remain inaccessible.

## Composition and Ownership

Recommended placement: Referrals and partners. Own broker agreement-rate commissions and provider transfer/bank-payout outcomes. Share attribution with CanRefer while keeping commissions reserved through uncertain provider outcomes; a manual referral settlement cannot settle a broker payout. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

### Provider account and settlement evidence

Verified partner accounts enter a provider-hosted onboarding flow; the app never accepts bank-detail fields. Account observations bind the same partner/provider identity with monotone revisions. Only a provider-confirmed ready state enables local settlement admission, and the adapter rechecks actual funding/account eligibility when allocating. Onboarding links are recipient scoped and expire; they are not general account credentials. This explicit CommissionV1 provider contract remains unimplemented.

Settlements freeze their destination account and amount independently of later partner maintenance. All successful delivery results and verified events pass through the same amount/source/account/revision checks. Provider allocation failure releases a reservation only when definitely unallocated; bank failure after allocation keeps the commission consumed. Contradictory later allocation failure after a transfer raises finance review rather than creating spendable money. A verified reversal means the allocation itself returned to the platform, not merely a failed bank payout. Per-settlement schedules reconcile pending states; authorized refresh can inspect terminal outcomes and later returns.

Qualification checks source namespace/attribution, an owner-qualified exclusive program identity, distinct customer/partner account, product, allowed location, positive original amount and source revision. Frozen original evidence rejects changed source payloads and same-revision conflicts; an earlier reversal leaves a tombstone preventing delayed qualification. Inactive partners still receive reversals. The commission rate, agreement and qualifying milestone are snapshotted when the sale first qualifies, not when its original purchase is captured. Later changes never reprice that sale.

The actual Invoice source now receives `SaleMilestone` through `SalesIngressV1.observed`, validates the billed customer/location/original amount against its collections/refunds and emits committed `SaleQualification` for `SalesV1.qualification`. Rent and Member own the actual purchase/completion/disqualification observations; they cannot assert a new-customer decision. The binding must authenticate each allowed producer namespace and map its committed `CommercialSaleChanged` event to that ingress, then route the Invoice outcome to consumers. Source revisions and Invoice qualification revisions are separate. These declared mappings and the CommissionV1 provider adapter remain unimplemented, not automatically supplied by exporting a capability.

### Shared capture and statements

The actual `sales_attribution` package in CanRefer.can owns one Customer-scoped Capture and one verified `capture` operation for either Advocate or Partner. `/partners/share/{Partner.id}` binds the partner and shows only its public name; the customer must explicitly authenticate and submit their authorized customer identity. The operation excludes self-attribution and snapshots code, owner-qualified program identity (`affiliate.Partner:{id}`), account, capture time and the partner's attribution window. Source purchase admission selects the latest active, nonself, unexpired capture eligible for the actual location and product; deterministic `captured,id` ordering breaks ties. Sources freeze this choice, and `purchased_at` is distinct from a later qualification time. A page GET alone records nothing and grants no commission access.

Verified partners can export their scoped sale, adjustment and settlement tables through the existing generated Model.export CSV toolbar contract in DESIGN §9. Period/currency filters constrain sale exports; safe source/transfer/payout references remain available, while customer/account fields excluded by the partner grant do not enter statements. Export is a shared renderer/runtime obligation, not a new app formatter or provider.

Inline examples describe affordable/forbidden settlement, source replay/conflict and reversal-before-qualification, inactive-partner reversal, onboarding ownership, stale account observation and definite-unallocated versus allocated failure. Only syntax parsing ran; provider bindings, account/funding normalization, compiled exports and example execution remain implementation work. No source currently invents `cancellation_passed`: agreements choosing that milestone await a recorded source cancellation-period policy. Paid/completed source paths are authored.
