# CanLoyalty requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanLoyalty.can](CanLoyalty.can).

## Purpose and Adoption Goal

Help the workspace operator reward repeat paid workspace visits with points, tiers, and fulfillable perks. Adoption depends on a customer seeing their balance and staff knowing which reward to deliver.

## Users and Permissions

Program staff configure tiers/rewards and record authorized point adjustments. Customers linked through verified accounts can view only their own balance and request their own redemptions. Staff handle fulfillment and corrections; a customer's contact email alone is not authorization.

## Data and Ownership

Customer stores name/contact and optional linked verified account. Tier stores name and a unique non-negative earned-point threshold; the highest qualifying threshold determines the customer's tier. Reward stores name, active state, and positive point cost. Point entries have stable IDs, recorded correction authors/reasons, an explicit tier-earning flag, and immutable reversal links. SourceEvidence retains the latest Invoice qualification revision and permanent reversal/decision markers per enrolled account. Redemption freezes reward name, instructions, applicable locations, chosen fulfillment location and point cost; its lifecycle separately records staff evidence/authorship and one typed Mail.send association, while the displayed notification outcome reads that retained receipt, never a stored copy. Tier progress uses eligible earning minus its reversals; ordinary redemption and goodwill corrections do not reduce or increase it. An authorized correction explicitly selects whether it repairs tier earning. The highest threshold at or below earned points is the current tier. Progress compares earned points above that threshold with the distance to the next threshold, rather than dividing by total next-tier points. No next tier means zero span/progress and the highest tier remains recorded; no tier yet uses the zero baseline, with progress clamped at zero for an owed earning balance.

Record qualifying booking/payment source references, location applicability, and reward fulfillment instructions. Initial rewards are manually fulfillable perks such as a café voucher or welcome pack; tiers provide recorded program status.

## Workflows and Business Rules

Reserve reward points in the same mutation that creates the redemption. Fulfillment uses that reservation once; cancellation returns the snapshotted cost once. Reversing an earning after its points were spent may create an owed balance; it must still be recorded, with new redemptions blocked until affordable. Reward price changes never alter old redemptions.

A configured earning policy credits completed, financially qualified sales only from the declared Invoice SalesV1.qualification binding. Deliberate staff Account enrollment and the Program’s explicit products/locations authorize points; enrollment and ledger corrections require work authority for every location in that program. The supplied example policy accepts Rent’s `meeting` product and Member’s `membership` product. Rent publishes booking completion and Member publishes term completion; Invoice verifies actual payment/refund evidence before publishing qualification. Repeat customers need neither first-customer status nor complete commercial-history evidence.

Referral/affiliate `exclusive_program` identifies a separate cash-attribution owner (`refer.Program:<id>` or `affiliate.Partner:<id>`); it is never a Loyalty Program ID and does not enroll a customer in points. An attributed sale can also earn points in an explicitly enrolled matching loyalty program. If staff deliberately enrolls the customer in several matching loyalty programs, each enrollment is an intentional offer under its published terms; attribution alone never creates an enrollment or program fanout. This preserves [PORTFOLIO’s ownership and unintended-reward boundary](PORTFOLIO.md#canonical-record-ownership).

Store source identity/revision and immutable customer, purchasing account, location, product, amount, purchase instant and capture association. Equal revisions require equal qualification payloads; earlier positive revisions cannot replace the latest evidence. Make the first completed eligibility decision once, so a later configuration change and replay cannot create an old unearned credit. Cancellation/refund qualification permanently marks reversal, reverses a credited source once, and prevents a later completed message from restoring it. Process reversals even after program deactivation or policy changes; a reversal arriving before completion is a tombstone. A source is unique within its enrolled account, while a reversal reference can occur only once. Program and reward policy changes do not rewrite old ledger entries or redemption snapshots. Point corrections record a nonblank reason and authenticated staff author; zero corrections and reversals of reversals are invalid. A manual correction reversal negates its original tier classification and points once. Fulfillment/cancellation require work authority at the redemption’s frozen chosen location, independently of current reward price, instructions or active state.

First-version rewards cannot promise reserved workspace or automatically grant room time or act as invoice currency. Adding workspace rewards later requires a separately specified CanRent reservation and reward-settlement capability.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). When this optional product is offered, order navigation as My rewards, Reward fulfillment for authorized staff, then Reward program for program owners. Reward/redemption details stay contextual. Protected program administration stays separate from preferences and fulfillment.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| My rewards — verified own customer index | `breadcrumbs` plus a `hero` overview: split `stat` available/earned values, tier labels, tier-span text with a gated tier-progress `progress`, and rewards/history `tabs` bound to the remembered view. Reward list with `tooltip` redeem form; redemption Table with state `badge`, notification `status`, `pagination` and empty states; earning `timeline` with per-item `pagination`. | Reserve an affordable active reward through the guarded redemption operation; email or contact matching alone grants no account access |
| Redemption detail — contextual own/staff view | Reserved/fulfilled/cancelled state `badge` with snapshotted cost, frozen reward instructions/locations, earning/reversal references, attributed fulfillment evidence and a separate notification `status` reading the retained receipt outcome | Read the current receipt outcome; changing reward price cannot alter the old reservation |
| Reward fulfillment — scoped staff queue | `breadcrumbs`, location/status Select filters, and a redemption Table with state `badge`, notification `status`, `pagination` and empty state. Fulfill moves into a `modal` opened by `button opens=`, with an inline form carrying placed label/textarea/validation; per-row cancel `modal`; per-account adjust form with typed correction controls; earning Table with `pagination`, empty state and reverse `modal`. | Fulfill or cancel the existing reservation once; earning review and attributed corrections use guarded ledger actions, never direct balance editing |
| Reward program — protected owner index | `breadcrumbs`, a program form with placed term/cost/active controls, and tier/reward lists with `pagination`, empty states and threshold/cost/active text | Maintain published terms, tiers and rewards only under program-owner grants; customers cannot price their own reward |

Stack reward conditions and the point cost beside the redeem Button on narrow screens; present history as labeled rows. Distinguish loading, no points, no eligible rewards and filtered-empty. Preserve unsaved fulfillment evidence/program edits after invalid or stale submissions. Concurrent redemption refreshes affordability without promising the unavailable perk; repeated commands show their original outcome. Show notification failure independently of reservation state; a redemption with no associated notice shows the standard not-requested outcome. A reversal can produce an visible negative available-balance metric and owed-balance guidance that blocks new unaffordable redemptions while retaining history. Cancellation returns only the snapshotted reservation once. Workspace availability, membership units and cash never appear as interchangeable loyalty balances, and redemption is not evidence of delivery.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Customers may remember an eligible reward location and reward/history starting view; staff may remember an authorized fulfillment-location/status filter. The rewards/history `tabs` and the redemption-table location/status defaults read these remembered values; `breadcrumbs`, `pagination` and empty states carry no personal state. Clearable display defaults are revalidated against access. They cannot modify points, earning policy, tier thresholds, reward costs or fulfillment instructions. Program controls stay protected; exclude source/provider setup from preferences.

## Admin and Management Surfaces

End-user admin is required for published reward-program administration, only when loyalty is offered. The operator's program owner must set the shared rewards, tier thresholds and earning/redemption terms offered to customers. A participant cannot set the cost or rules of their own reward.

Provide a protected reward-catalog/program-terms view for authorized program owners. Earning review, attributed corrections and reward fulfillment remain normal staff operations. Customer balances use guarded ledger operations, not an admin balance editor; cash and membership units remain separate. See [end-user administration scope](ADMIN_SURFACES.md).

## Interfaces and Integrations

Use D1 for loyalty records and EmailService for redemption notifications.

## Background Actions

Email a customer when their redemption is created.

## Error Handling

Repeated redemption commands return their original result. Two simultaneous requests cannot use the same points. Reject direct edits to ledger entries or cost snapshots; failed notification does not cancel a recorded redemption.

## Draft Status

The source and [handwritten desired JavaScript target](CanLoyalty.mjs) now express enrollment/product/location qualification, source revisions and tombstones, paid-completed earning, tier intervals, guarded attributed adjustments/reversal, frozen-location redemption, fulfillment/cancellation, and a typed redemption-notification association whose outcome observes the retained Mail receipt; the pure receipt-copy completion callback is removed. Inline examples add the fresh pending receipt observation to redemption and a fulfillment table covering pending/succeeded/failed/unknown/skipped plus the null not-requested association. The three eligibility consultations and their uncertainty are saved under [design/jev/loyalty-eligibility-20261004](../design/jev/loyalty-eligibility-20261004/assessment.md). Imported stdlib/UI/owner contracts are proposed and unimplemented. The current parser rejects the canonical `delivery(Mail.send)?` field type; a disclosed temporary projection replacing only that type with `text?` accepts the surrounding declarations, the operation-resolved recipe and all seventeen tables, checking surrounding syntax only. Node syntax checks do not execute workflows, examples, read policies, concurrency, bindings or notification delivery. The deferred test contract follows DESIGN §13; no fixture provisioning or runner is supplied. The bounded presentation catalog uses typed table states, labels and metrics with explanatory text; it does not invent conditional Alert or Progress primitives.

## Scope and Completion

Complete when a customer can redeem only their points, changing reward cost preserves old balances, and reversal/cancellation cannot double-return points.

A repeat customer can earn points from a real completed booking, redeem a welcome perk, and see staff fulfillment without treating an email or point deduction as proof the perk was delivered.

Frontend journey: a verified customer sees distinct available points and tier progress, reserves a welcome perk and receives a reserved Badge even if notification fails; a second concurrent request cannot spend those points again.

Frontend journey: staff filters the permitted fulfillment queue, records delivery evidence and sees fulfilled history. A later reward-price edit preserves the original cost, while an earning reversal remains visible and can block a new unaffordable redemption.

## Composition and Ownership

Recommended placement: Optional loyalty module. Own earned loyalty points and manually fulfilled perks. Product/time allowance accounting stays in CanMember and cash commissions stay in CanRefer/CanAffiliate; shared navigation cannot convert one balance to another. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.
