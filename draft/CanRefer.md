# CanRefer requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanRefer.can](CanRefer.can).

## Purpose and Adoption Goal

Help workspace members and advocates earn fixed cash rewards for bringing in qualifying new workspace customers. Adoption depends on easy sharing and being able to distinguish earned, reversed, owed, and actually paid rewards.

## Users and Permissions

Require team authentication for program management. Advocates are identified by email; visitors can follow their referral links.

Link advocates to verified accounts for an own-referrals/rewards page. Authorized program managers handle qualification exceptions with reason; finance alone records evidenced reward settlements.

## Data and Ownership

Programs have a name; referrals identify their advocate by contact email. Program stores reward/currency, configured destination, qualification policy, and a default 30-day attribution window. Referral codes are globally unique public identifiers. Conversion records trusted source identity, external ID, attribution evidence, qualification/credit history, and the reward amount applicable when credited.

Record eligible locations/products, qualifying paid booking or membership source, and qualification milestone. Settlements retain operation identity, advocate, allocated reward entries, amount/currency, payment date, method, external payment reference, and actor. External references are unique within their payment source. First-version rewards are cash amounts in the program currency, not implicit workspace credits.

## Workflows and Business Rules

Default attribution uses the last eligible code captured within the program's window. The integrating site must explicitly carry that evidence to ingestion; a redirect alone cannot prove a purchase. Default rewards cover a customer's first qualified conversion per program and exclude the advocate's own verified identity. Snapshot credited rewards so program changes do not reprice past earnings.

Default qualification requires a new customer's first paid, completed workspace booking, or a paid membership term that passes the program's recorded cancellation period. An authorized manual settlement atomically allocates available reward balance to recorded external payment evidence. Repeated/concurrent settlements cannot allocate a reward twice. A reversal after settlement preserves payment evidence and creates an owed balance, blocking further unaffordable settlements; do not pretend to claw money back automatically.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Sidebar order is Referrals then Referral rewards; authenticated advocates receive their own view, with program-management and finance controls gated separately. Public referral URLs lead only to configured destinations and grant no reward-record access.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| Referrals /referrals | Program List with reward Badge and tooltip-annotated join Button; own advocate rows with copy-link control, destination text, code Badge, earned/paid/available/owed Stat, owed-only Alert Card, Evidence Divider, and evidence Tabs with Pagination. | join binds the listed program and copy shares the configured referral URL; verified own-account scope, unique code and allowed destination remain authoritative; owed alert renders only when a reversal preserved a settlement. |
| Own conversion and payment history | Nested Credit and Settlement Tables show trusted qualification, reversals, payment references, dates/method/evidence and frozen reward amount. Both evidence Tables carry explicit Pagination; the Credit Table has an explicit no-conversions empty state. | Authorized read and scoped statement export; opening a link or viewing a notification cannot qualify a conversion or prove payment. |
| Referral rewards /referrals/work | Program maintenance Card with generated create Form and Program List with reward Badge; per-advocate Stat; SourceEvidence queue Table with Pagination and per-row reject Modal with reason Textarea; per-advocate settlement Card and history. | Program CRUD requires manager grants; qualification exceptions use attributed owning decisions, not unrestricted credit edits. |
| Manual settlement | Settlement Fieldset grouping payment source/reference/method/evidence Inputs with paid-date Calendar around the generated amount control. | settle atomically allocates affordable balance to evidenced external cash payment; concurrent/replayed requests cannot allocate twice. |

These logical history/settlement sections reuse existing pages rather than introduce a separate administration console. Mobile Cards retain currency, reversal linkage and payment evidence. Distinguish no conversions, awaiting qualification, source unavailable and a genuinely zero balance. Show processing and failed delivery separately from earned funds; preserve settlement input on validation or stale-balance conflict. A late reversal keeps the prior payment visible and shows owed balance, never a claimed automatic clawback.

## Personal Configuration

Inherit first-class personal account, language and appearance controls from [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Remember only the advocate's history range or authorized finance location/program/currency filters, with typed validation and reset through the shared save path. Filters do not change attribution windows, qualification milestones, reward snapshots or settlement authority. Program terms are normal manager business records, not personal preferences; payment/provider setup remains outside the product UI.

## Interfaces and Integrations

Conversion ingestion is server-to-server with scoped credentials, not authorized by the public referral code. Require referral identity, external conversion ID, customer identity, and qualification evidence. The source app implements capture of the ref parameter using its own tracking policy. Redirects use only the configured HTTPS destination, never a visitor-supplied URL.

Declare paid/completed booking, membership qualification, and refund/disqualification ingestion. Manual settlement records an external cash payment; this app does not initiate bank payments.

## Background Actions

Notify an advocate when an attributed conversion becomes qualified.

## Error Handling

Return the prior result for repeated source events. Conflicting reuse of an external ID is an error, not a second reward. Refund/disqualification creates a linked reversal, preserving the earlier credit and notification history.

## Scope and Completion

Complete when source integration supplies real attribution, repeated purchases cannot bypass the qualification policy, and changing rewards or reversing a conversion preserves history. Earned rewards are accounting records, not automatic payouts.

A member can share a link, see a real new-customer booking qualify, and trace its cash reward through an evidenced manual payment or later reversal. Earned rewards are no longer indistinguishable from delivered rewards.

Frontend acceptance journeys:

- An advocate copies a link, sees a source-backed first qualifying booking credited and traces the reward through a finance-entered payment. Replayed conversion/payment evidence adds neither a second reward nor another allocation.
- A settled conversion is reversed: history retains original credit/payment, owed balance is explicit and unaffordable settlement stays blocked. Switching language preserves an unfinished payment form and its selected currency.

## Composition and Ownership

Recommended placement: Referrals and partners. Own fixed cash member-referral program credits and manual settlement allocations. Share source attribution with CanAffiliate but retain separate eligibility and settlement evidence. CanLoyalty points and CanMember allowances are different balances. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

### Authored capture, qualification and settlement

CanRefer.can now contains the actual shared `sales_attribution` package. Its single `capture` operation accepts exactly one Advocate or Partner, requires verified Customer ownership/administrator/booker authority and excludes the origin's own account. It snapshots the public code, owner-qualified exclusive program identity, account, time and policy window into locked Customer-owned Capture fields. `/referrals/share/{Advocate.id}` supplies the public code/configured HTTPS destination and binds only that advocate; anonymous GET does not create attribution. The own portal copies that app link. Continuing to the configured external destination is explicit; this source does not claim an automatic redirect or browser tracking integration.

Booking, quote and membership purchase admission use one optional Capture and `latest_capture(customer,person,location,product)`. Selection checks the actual product/location, active/nonself origin and expiry, ordered by descending capture time with the shared ID tie breaker. Source records freeze the selected evidence before payment. The attribution window applies to `purchased_at`, not to later completion, so a valid purchase can qualify after the window expires.

The Invoice owner receives actual `SaleMilestone` observations, checks the billed original source/customer/location/amount against its authoritative payment ledger and emits `SaleQualification` for `SalesV1.qualification`. Its reviewed CommercialHistory baseline identifies the earliest paid customer invoice using real receipt timestamps and stable record ordering. Missing historical completeness or timestamps produces `history_known=false`/`first_customer=false`; public code possession cannot supply either flag. Finance reviews the complete baseline with evidence through the actual `review_commercial_history` operation. A later history contradiction withdraws eligibility instead of silently preserving a first-customer claim.

Refer retains one source-evidence record per stable source, rejects changed identity/attribution and same-revision conflicts, ignores stale observations and keeps reversal tombstones even before a credit exists. Only a real matching Capture plus verified first-customer, product/location and completed/cancellation-passed evidence can credit once per customer/program. Credit amount is snapshotted at qualification time. A source reversal or loss of first-customer/history eligibility creates one linked negative credit, including for inactive programs; source or payment replay adds nothing. Program managers can reject a source with a reason. Positive repairs belong to the owning source/payment-history decision; there is no unrestricted credit editor.

Finance settlements identify the external payment source as well as reference, amount, date, method and evidence. An identical repeat returns the prior settlement before checking the now-spent balance; conflicting reference reuse fails. Available and owed balances are distinct nonnegative values, and atomic credit allocation blocks overspending. Reversal preserves the settled payment and creates an owed balance. Own advocate reads require verified identity; program-manager/finance reads and actions remain location scoped. Source queue fields show unknown history separately from a real zero balance.

Own credit/settlement tables provide existing generated scoped Model.export CSV statements under DESIGN §9; their payment-source references, currencies and authorizations are retained. The MJS target includes shared capture policies, operation/derive metadata, the actual receiver/settlement handlers and deferred fixture callbacks. It remains a handwritten target using proposed imports. The parser and JavaScript syntax check ran; the example runner, compiler, bindings and renderer did not. Install explicit committed-source-to-Invoice and Invoice-to-consumer mappings before claiming an integrated application. Membership currently supplies paid/completed/disqualified term facts; no producer claims a recorded cancellation-period milestone until that source policy exists.
