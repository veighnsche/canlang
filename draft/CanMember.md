# CanMember requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanMember.can](CanMember.can).

## Purpose and Adoption Goal

Help the workspace operator manage paid membership terms and a useful customer member portal. Adoption depends on clear plan eligibility, location information, and reliable access to the services the customer actually purchased.

## Users and Permissions

Authorized membership managers administer memberships. An assigned eligible user may read an individual/company membership's paid content only while their applicable term and assignment are active; their authenticated account, own billing history, and renewal/cancellation requests remain reachable after expiry or revocation.

Location or membership managers administer permitted customer memberships; content editors manage member information. Customers use verified accounts and can see only their own memberships and authorized content. Operator employee team membership and customer membership are separate.

## Data and Ownership

Membership links the operator and an individual user or customer organization to a named plan. Separate membership identity/plan from immutable billing terms. Each term records start/end instants, amount/currency, payment operation, and provider outcome. Membership access is derived from an applicable paid term plus its paused/expired state, not a freely editable active flag.

Plans specify description, eligible locations, workspace product eligibility, published access hours, and any named service entitlement such as mail handling. Such service benefit periods are snapshotted; CanMail owns physical handling instructions and item evidence. Snapshot these benefits on each billing term so later plan edits cannot silently change paid benefits. Member content records title, category, location/plan audience, publication state, text, and optional immutable file versions. Do not store physical door secrets as general member content.

Support a term owned by an individual or customer organization. Company plans snapshot paid seat capacity and per-location/product benefits; assignments link eligible verified organization users to that term with active/released history. Invitation acceptance and paid-seat assignment are different records. Record billing anchor, timezone/calendar rule, interval, auto-renew consent, cancellation effective date, and a unique cycle ID. Seat-count or price changes affect a newly identified term or explicitly priced amendment, never old terms.

The allowance ledger stores product/time units (for example desk-days or meeting-room minutes), beneficiary user/company pool, paid term/period, granted amount, available/reserved/consumed/expired amount and immutable reversal links. Unit costs and money-overage calculation are snapshotted from explicit plan/product rules; points, currency, minutes and desk-days are not interchangeable. Compute positive whole allowance units by the explicit product quantity/duration/increment rule, and attribute them to the service period in which each use occurs. A cross-period booking reserves the applicable amounts against each eligible paid period at the beneficiary ledger authority. Initial monthly allowances expire at the recorded period end without rollover. A future paid period is a distinct grant and cannot be spent on an ineligible current booking.

## Workflows and Business Rules

Create a new identified term with a future end before collecting its dues. Confirmed payment activates only that term; an old delayed payment callback cannot reactivate a later unpaid period. Early renewal can pay a future term without cutting off current paid access. Pause/revocation immediately denies paid member content and current plan privileges.

Allow members to view their current/future paid terms, request an explicit renewal term, and request cancellation with a recorded effective date and outcome. Staff apply the recorded refund/revocation policy. Published site information includes reception hours, arrival/check-in instructions, house rules, facilities, and support contact. Plan eligibility permits a booking request but does not reserve capacity. Workspace bookings use an explicitly configured full-money price or included product/time allowance with a quoted monetary overage; all outcomes retain their own identified source and period.

Company administrators may allocate only available paid seats to active eligible organization users. Concurrent allocations cannot exceed capacity. Releasing a seat revokes that assignment's prospective plan eligibility; retain history and surface affected future reservations for authorized resolution. Removing a person's company role makes organization actions fail immediately; seat/device reconciliation stays visible and cannot grant staff access.

Reserve allowance units atomically against the term's shared ledger with a stable booking-operation identity. Consume a reservation once at confirmed fulfillment and release it once after safe confirmed failure or a refundable cancellation. Restoring an old consumed allowance after its period expired records history but does not mint spendable credit in a new period. Changes to plan rules never alter committed usage. Show configured same-currency monetary overage for uncovered units; CanInvoice collects that remaining money balance in full.

Recurring renewal creates one provisional identified next term and source charge for each billing cycle, using the snapshotted cadence/calendar rule (month-end anchors clamp to the last valid local day). An authenticated settlement activates only the matching term. Auto-renew requires recorded consent; disabling it stops new cycles from the effective cancellation date without ending existing paid access. Generation failures remain visible and recoverable; replays do not create duplicate invoices or grants. A confirmed failed payment leaves the next term unpaid, prompts customer action and bounded finance collection. Current paid access lasts until its paid term ends unless separately revoked; without another paid term, new benefits stop at that end. The initial failure policy grants no automatic unpaid grace access. Reinstatement requires current valid paid-term evidence, not a cleared reminder.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Order accessible navigation as My membership, Member information, Membership register, then Membership plans for plan owners. Contextual member details retain authenticated billing/renewal after expiry. Customer and employee identities remain distinct.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| My membership — own index | Current/future term Cards with price/currency, paid state, seats, eligibility periods and cancellation Badge; allowance history/reservations Table | Request identified renewal/cancellation, change recorded auto-renew consent and follow next invoice/due/failed-payment actions; own booking/ticket/invoice/support links require their source grants |
| Member information — paid-content index | Published site guides in List/Card groups with reception hours, arrival/check-in, house rules, facilities and support/contact | Read current eligible location/plan content; contextual Reception invitations or Mail items retain independent role checks |
| Membership register — permitted staff index | Location/plan/status filters, member search, term/payment/collection history and separate period-bound allowance Stat totals | Maintain memberships/terms, copy current payment links and apply authorized pause/revocation/refund policy through owning actions |
| Company seats — contextual own-company view | Purchased capacity/assignment Table, units/overage terms and reconciliation Alerts | Authorized company administrators assign/remove only available paid seats; affected future reservations and device reconciliation remain explicit |
| Membership plans/content — protected owner/editor views | Plan/benefit Fieldsets and unit rules Table; content publishing fields limited to editor grants | Plan owners maintain sellable plans/benefits; content publication cannot change paid entitlement or historical snapshots |

On mobile, place paid-until, next action and expiry/renewal before history. Distinguish loading, no applicable paid term, no granted content and filtered-empty. Preserve unsaved consent/content input on validation or stale saves. Show pending/failed/unknown collections and seat/allowance reconciliation without unpaid grace. Display granted/reserved/consumed/expired units separately; an expired-period release never creates current credit. Use recorded business timezone/calendar periods and frozen unit/overage rules. Customer price, seat and allowance history survives expiry; paid content is reauthorized on each request. Separate plan administration from personal settings; exclude provider/retry configuration.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Users may save an authorized location and membership/content starting view; staff may save permitted plan/status search filters. Clear/reset and revalidate saved grants. These choices cannot select eligibility, grant seats, alter unit periods or enable auto-renew. Renewal consent, cancellation, payment methods and paid-seat allocation remain explicit authorized business actions on their own views; language cannot reinterpret the term's calendar or money.

## Admin and Management Surfaces

End-user admin is required for membership plans and entitlement administration. An operator membership administrator must maintain shared sellable plans, paid-seat limits and included benefits that apply to member accounts. Members and content editors cannot change the rules of their own paid entitlement.

Provide a protected plan/benefit administration view for authorized operator membership managers. Company administrators allocate only their purchased seats through the own-company view. Renewal, collection review, content editing and fulfillment remain their ordinary business workflows; do not build a generic system-settings console. See [end-user administration scope](ADMIN_SURFACES.md).

## Interfaces and Integrations

Use D1 for memberships, one configured collection owner (the Stripe payment adapter or a declared CanInvoice billing contract) for dues, and the shared access capability to enforce membership for paid member content. Match confirmed settlement to the specific billing term, never to a generic user-level active flag.

Use R2 for bounded member documents. Declare member eligibility reads for CanRent and own-record links or capabilities for invoice, support, and event views. Logical portal/booking eligibility does not itself provision a door key or operate access-control hardware.

Use CanCustomer as the company/user/role source and CanInvoice as the collection owner in the composed profile. Publish scoped eligibility, seat allocation/release, and allowance reserve/consume/release/read contracts with current term/period/revision. Identity removal and paid expiry create attributable reception revocation work. A standalone payment profile must remain the one configured owner, never charge alongside invoice collection.

## Background Actions

At the paid term's end, recompute access using current paid terms. Reconcile uncertain payments and provider refunds; retries keep the same term/payment identity. Never reschedule an already expired date as if it were a new cycle.

Generate provisional renewal cycles at the configured lead time, send one current cycle notice and process settlement/failure/cancellation events. Expire allowance periods, end invalid seat benefits, and queue reception/device revocation at the applicable access end. Re-read consent, term, paid state and assignment before notifications or activation; uncertain outcomes retain their operation identity.

## Error Handling

Reject activation without a valid paid period. Browser-return or stale provider events cannot extend access. Refund/revocation must have an explicit recorded access outcome; member content is re-authorized on each request and not served from a shared public cache.

## Scope and Completion

Complete when early renewal preserves current access, expiry denies access unless another paid term applies, and repeated old callbacks cannot grant a new period. Explicit terms remain the evidence for access; recurring renewal generates identified terms/charges with consent and configured collection rather than an editable active flag.

A paid member can read their location's guide, understand their eligible products/hours, reach their own reservations and invoices, and renew; expiry or revocation removes paid privileges without hiding the authenticated renewal/payment history needed to resolve them.

Complete when company invitations cannot overallocate seats, two bookings cannot spend the same allowance, expired-period cancellation cannot refill a new period, and a recurring cycle creates one billable term/invoice. Failed renewal stops new benefits at the existing paid end while preserving own billing/renewal history.

Frontend journey: a member reads an eligible site guide, follows their own booking/invoice link and renews early without ending current access. At expiry, paid content disappears while authenticated billing/history and an actionable renewal path remain.

Frontend journey: a company administrator encounters exhausted paid seats or an allowance conflict and sees the recorded reconciliation outcome. Failed recurring payment leaves the next term unpaid; old settlement or expired-period cancellation cannot grant new benefits.

## Composition and Ownership

Recommended placement: Workspace. Own plans/entitlements, membership terms/seats/allowance ledger, and portal content in separate packages. Compose with CanRent and reference CanCustomer identities. CanInvoice owns the composed profile's charge collection; reception/device credentials remain in CanReception. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Authored Owner Workflow and Contract

`CanMember.can` is the authority for the proposed signatures and guards. The exported `MembershipV1` is a declared, unimplemented import contract; no generated client, adapter or executable membership runtime is claimed. The owner uses one `MembershipIngressV1` binding, with trusted `actor=null` handlers. Browser/MCP clients have the authored term, consent, cancellation, seat and manager operations; they cannot invoke trusted ledger ingress directly.

The installed membership binding authenticates each permitted producer, fixes its selected-app/team/customer namespace, and retains the original delivery, canonical operation kind and immutable request digest. `customer` resolves the authoritative `Customer` before source lookup; a source is unique within that owner and producer namespace. The binding rejects producer/source substitution, mismatched resource/customer routing and a reused source with altered account, product, interval, quantity, unit, money rule or predecessor. A producer must authorize its own business action before dispatch; a customer/user value in a request supplies no delegated role. The mapping is an implementation obligation, not an authored build manifest.

| Public operation | Verified ingress | Committed outcome for its originating delivery |
| --- | --- | --- |
| `reserve` | `MembershipIngressV1.reserve` | `ReserveOutcome.value` |
| `commit` | `MembershipIngressV1.commit` | `CommitOutcome.value` |
| `consume` | `MembershipIngressV1.consume` | `ConsumeOutcome.value` |
| `release` | `MembershipIngressV1.release` | `ReleaseOutcome.value` |
| `reconcile` | `MembershipIngressV1.reconcile` | `ReconcileOutcome.value`, preserving a nullable result |
| `eligibility` | `MembershipIngressV1.eligibility` | `EligibilityOutcome.value` |

Only an outcome committed by the matching ingress can complete that delivery. A rejected or rolled-back operation yields a typed failed receipt; absent commit evidence stays unknown. `AllowanceChanged` maps separately to `MembershipV1.allowance_changed`, and `EligibilityChanged` to `MembershipV1.changed`; their domain revisions do not complete other outstanding operation kinds. Reconcile returning null proves no allocation snapshot was found, not that cancellation succeeded. A pre-creation release instead commits `BenefitFence` and returns an explicit released `OperationOutcome`; a late reserve for that source is rejected.

`Entitlement` carries exact `BenefitInterval` windows and frozen product, unit, duration, rate, beneficiary and predecessor. Hourly segments must be aligned to the snapshotted duration; each exact day window consumes one daily unit per quantity, independently of elapsed opening hours. A day window must fit one paid grant. Hourly spans crossing a paid-period boundary allocate their aligned segments to their respective eligible grants. Overlapping requested windows, overlapping eligible grants, missing paid coverage, changed unit rules and invalid seats are rejected. Units use decimal representation with whole-unit invariants because duration division returns decimal; the source does not invent integer conversion or rounding-up primitives.

Each grant snapshots `Benefit.overage` in its plan currency. Its request reports total units, covered units and the uncovered units' monetary base. CanRent applies its own frozen tax/discount rules and collects only that remaining money balance after committed reserve evidence. A transport receipt, catalog full price, or configured points value cannot establish that balance. Zero covered units can still yield an eligible full monetary-overage quote; inability to establish a paid plan/product/window is not silently treated as allowance coverage.

A replacement names `previous_source`. It has at most one staged successor, credits only the same nonexpired grant, and holds only positive extra covered units while preserving the original allocation. Compensating the stage restores its extra holds and leaves the original state untouched. `commit` occurs after all replacement capacity and money owners accept, rechecks entitlement, and atomically releases the predecessor and admits the new allocations. The returned `phase` distinguishes staged, reserved, consumed and released records even when a transport/domain outcome is confirmed.

Rent consumes included units at booking confirmation, before physical arrival. Replacing such a consumed booking requires explicit `restore_consumed=true`; the receiving binding admits that flag only from Rent's canonical authorized own-booking replacement/cancellation workflow, with current `checked_in==null` and its frozen refund deadline and restoration policy satisfied. Membership cannot infer physical use from its ledger. The consumed predecessor stays consumed while staged; commit records an immutable reversal and preserves the consumed phase on the replacement. A consumed-release request needs the same owning policy authority. A reversal after the original grant expires remains history and cannot grant current-period credit.

Purchased access is authored as plan-owned `AccessHours`, including location, weekdays, local times, day offset and fold. The term snapshots those windows and their business timezone; `access_hours` is the authored human summary, not executable time syntax. Requests must fit an authored purchased window. Reception eligibility also checks the location's current opening calendar, caps its evidence at the current purchased window/paid-term end, and retains no automatic guest allowance. The plan/location owner must explicitly author any overnight or broader purchased windows. Paid content remains readable throughout an applicable term, while reception admission respects the purchased hours.

Renewal uses a single `Renewal` identity per membership/cycle, its original calendar anchor, and a frozen consent reference. Customer or scoped manager requests remain reachable after expiry; they do not terminate an earlier term. Record-bound recurrence schedules admit due cycles seven days in advance, catch up in batches of 24, and skip expired periods without charging. They recheck current consent, cancellation date and plan state at admission and at charge dispatch. Replays reuse the cycle and source; generation receipts remain visible, and retry schedules the same renewal identity. Disabling consent or requesting cancellation stops new automatic work and keeps existing paid access unless a separate authorized policy revokes it. Member does not implement another finance collection policy; CanInvoice owns bounded collection and payment-method recovery.

Term charge and reconciliation evidence use the exact frozen title, service period, price, currency, location and consent. Cumulative `Settlement.revision` advances only its matching term; neither an old payment nor a browser return can activate a new cycle. Refund policy records an explicit retained/revoked access decision. New partial refunds cannot be treated as full payment of a later term, and a manager's recorded retention decision does not manufacture initial payment evidence. Settlement and expiry generate access changes; each stored customer-routed `AccessWatch` increments its own revision. Customer active/archive/contact/role changes must emit `CompanyAccessChanged` from the customer owner so membership rereads current authority. Revoked seat assignments remain historical and may be reactivated only under current paid capacity and verified-user rules. Affected future allowance requests gain a visible review reason; owning booking/device workflows resolve them.

The authored pages include personal terms, renewal/cancellation/consent, paid seats, period totals and request reconciliation, scoped manager term/refund administration, plan benefit/hour administration and editor-controlled member content with plan/location audiences and bounded document attachments. Historical grants remain separate from live entitlement; payment and own history do not disappear merely because paid access ended.

## Validation and Remaining Implementation

`python3 tools/can_parser.py draft/CanMember.can` parses the source syntax. Inline examples cover anchored month-end renewal, requested-cycle admission, capacity/seat rejection, full/partial/no allowance coverage, misaligned hourly units, consume replay and release/restoration guards. They have not run against an executable canlang BDD runner. No `CanMember.mjs`, compiler/runtime, provider adapter, new validation framework or live payment integration was added.

Two saved JEV triples reviewed staged owner accounting and the later consumed-predecessor correction. The first returned staged/independent/staged and its disagreement was investigated as temporary double funding versus exchange accounting; the second returned NOUL 0.84/0.85/0.86 for the guarded preservation property. Complete requests, returned probabilities/uncertainty, wording reviews and assessment are in `../design/jev/member-owner-20261004/` and `../design/jev/member-consumed-stage-20261004/`. They are advice, not authorization, executable proof or a claim of bias elimination. Runtime work still includes atomic owner transactions, source/digest causation mapping, scoped dispatch/restoration authorization, schedule receipts/recovery, standard localized UI, file finalization and live access reauthorization.

CanMember explicitly selects the existing rent_fulfillment, invoice, desk and events packages alongside its membership owners. Their canonical My bookings, My invoices, My support requests and Events pages therefore participate in the same implicit shell under their own page/record/field grants. Composition deduplicates these owners when Workspace also selects CanRent. Membership adds no copied portal query, link DTO, route registry or permission. The existing BillingV1 binding still owns asynchronous billing; its textual references do not become action handles. Standalone deployments must configure that binding to the intended invoice owner.

### Whole-window guest eligibility

Plan guest limits are explicit nonnegative per-host concurrent entitlements and are frozen into each paid Term; zero permits no guests. A source-bound access watch freezes account, location and the complete requested interval. Eligibility checks current customer/seat/payment authority, purchased hours and location opening coverage for the entire remaining interval. Its guest limit comes from a qualifying single term covering that interval, never from an unrelated shorter grant. Responses carry checked time and a watch-local monotone revision; reconciliation advances that revision so delayed changes cannot replace a later observation. Reception owns its actual concurrent visitor count and freshness checks. These observations do not create a distributed atomic door-access guarantee.

### Committed commercial qualification producer

Manual term requests accept one optional `sales_attribution.Capture`. The canonical capture owner validates referral or affiliate origin; term admission checks its customer, member account, submitting account and current selected capture. The renewal request locks that record and the resulting term freezes its code, program, capture time and window. Automatic renewals do not silently reuse a prior attribution. Replaying the same cycle cannot replace its original capture.

New terms freeze the primary billing location actually used for the invoice. `member_terms.CommercialSaleChanged {value:invoice.SaleMilestone}` is a committed source event, mapped to `invoice.SalesIngressV1.observed` under a binding restricted to this producer's team and billing-source namespace. Its source is the exact original `Term.source`, amount is original `Term.price`, product is `membership`, account/customer/location are the frozen transaction identities, and source revisions advance only on phase changes. The immutable purchase timestamp is `Term.created`; attribution-window checks use that timestamp, so a later term-end milestone is not mistaken for a later purchase. The invoice owner joins that source to its actual invoice and payment/refund history before publishing `SalesV1.qualification`; a membership's local paid flag is never sufficient financial proof.

New cumulative billing observations, term-end boundaries and explicit refund policy changes trigger source evaluation. It emits paid, completed at the term boundary, or irreversible disqualification/reversal. Membership has no declared fixed cancellation-period milestone, so it does not fabricate `cancellation_passed`. Expired historical terms without the new billing-location evidence do not invent qualified-sale history. Duplicate phase observations emit nothing new; a reversed sale does not become qualifying again. The actual callback handlers and source event are authored; transport delivery remains the shared declared interface contract.

Four inline source examples cover initial paid publication, cancellation reversal, a terminal reversal fence and missing legacy billing evidence. They are not executed integration results.

Commercial publication uses one child CommercialSale per purchased Term for its monotone phase/revision. Its bookkeeping does not mutate the purchased Term merely to publish evidence. Repeated checks retain the same revision, reversal is terminal, and legacy terms without frozen billing location emit no fabricated history. The owning Invoice ledger still independently checks money and customer history.

Access invalidation advances through individual memberships, allocations and live access watches using committed continuation events and stable record-ID cursors. A 100-record match count cannot block an entire company’s revocation. Every continuation evaluates current eligibility, and new admissions check current authority independently. Archived watches emit a terminal ineligible observation without trying to edit archived evidence; current watches retain monotonically increasing observation revisions. Historical billing and bookings are not erased by company-role removal.


### Company access review without cancelling paid commitments

`access_review(customer,location)` is the explicit safe information grant for current company administrators at that location and scoped member managers. The owner exposes discoverable Membership access review and a company-record destination; customer/location form inputs remain canonical and current, not copied authentication. The report counts ineligible active assignments, future allowance requests needing review, pending discrepancies between current eligibility and recorded review, and recorded conflicts. It does not report an event receipt as applied, and it does not return private reception records. Staff using record pickers/contextual routes also need the existing Customer directory read grant; export visibility does not add it.

A verified contact, active/unarchived customer and location, current customer location membership and a booker/administrator grant at the requested location are checked on new allowance reserve and access-watch eligibility. Generic paid-term evidence retains its existing historical and financial meanings. A scope removed at one location cannot keep access merely because another company location remains granted. Customer role/contact changes still reread current identity; frozen paid Term and Seat histories are not dynamic grant invariants.

Future `consumed` allocations now join staged/reserved allocations in reconciliation. Their state, included units, overage and paid facts remain unchanged. Rechecking one allocation evaluates all current future allocations of its request, so a valid sibling cannot erase another allocation's conflict; restored eligibility clears an obsolete reason. The report's current `requests_needing_review` remains truthful before queued work records the reason, and `pending_reviews` identifies that discrepancy. A recorded conflict persists until a real current-state recovery or explicit owning seat/booking decision resolves it. No automatic financial reversal, paid reservation cancellation or confirmed check-in denial is inferred from the role event.

The independent review rechecked the already present `allocation.until>now` boundary. A focused snapshot example now contains one genuinely elapsed consumed allocation and one eligible future allocation on the same four-unit request: owner recheck clears obsolete review while preserving both consumption and paid-term evidence. It does not establish that the seeded historical workflow executed.

`recheck_access(customer,location)` queues the existing CompanyAccessStep/AllocationAccessStep/WatchAccessStep traversal, with the requested location retained in each continuation. Customer changes use location=null for all affected work. Each continuation selects one next stable record ID and evaluates current state; each emitted watch observation advances that watch's own revision. Replayed or delayed customer observations never restore a past grant. Seats remain active historical allocations until an authorized administrator/manager explicitly removes them; assignment/removal keeps the existing paid-capacity and owner guards.

Authored evidence uses existing fixtures: report tables cover valid versus unverified contact, unrecorded versus recorded conflict, and a stale reason after eligibility restoration. Allocation tables include future consumed commitments and clearing a stale reason. The shared sequence makes a real paid seat assignment, removes its company's booker grant through canonical `customer.remove`, observes current review, observes the beneficiary's lost current entitlement, queues recovery, explicitly retires the freshly queried seat while retaining the paid term/price, and rejects reassignment under the missing current company authority even though capacity is available. Another sequence actually changes the directory contact's email before inspecting/queuing allowance review. Captured lets are freshly queried after a successful mutation; neither sequence invokes trusted handlers or assumes queued work already completed.

Manual progress proof for 99, 100, 101 and 1000 independent records: a traversal selecting one next ID performs N bounded row steps and one empty terminal selection, rather than admitting N records to one atomic loop. No match-count threshold prevents record 101 or 1000 from being visited. Replays may repeat an already current observation, while later new records/admissions trigger owner events and still check current authority. The finite per-request allocation scan retains ordinary atomic/read bounds; these counts are a reasoning trace, not a runtime benchmark or permission to exceed those bounds. Aggregate reports fail explicitly if their read budget is exceeded and cannot call incomplete totals zero.

Supported syntax projection and all table examples parse after removing sequence examples. The full file fails at the first examples/do sequence because the initial parser/runner does not implement the settled extension. No generated matching MJS exists; the canonical owner operations, contracts, UI and table/sequence correspondence were reviewed manually, not executed.
