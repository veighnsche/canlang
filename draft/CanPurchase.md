# CanPurchase requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanPurchase.can](CanPurchase.can).

## Purpose and Adoption Goal

Help workspace managers authorize furniture, supplies, repairs, and other spending against location or project budgets. Adoption depends on a clear reasoned approval and a visible commitment balance.

## Users and Permissions

Requesters see/edit their own unsubmitted requests. Eligible assigned approvers review submissions without self-approval. Budget managers set budgets and view commitments; ordinary members cannot raise a budget to approve their own spending.

## Data and Ownership

Budgets have a name and belong to a team. Budget stores amount/currency and active state. Submitted requests snapshot amount/currency, requester, description, reviewer, and decision history. Approved requests remain commitments until authorized cancellation or closure; cancellation records who released one and why, and closed spending evidence remains immutable.

Record location/cost center, supplier, purchase category, requested items/quantities, required-by date, approval/rejection reason, and external purchase/receipt references. A budget may span one location or an explicitly permitted operator project.

Own the canonical supplier register with contact/business identity, permitted locations, active/archived state and immutable referenced history. Purchase orders snapshot approved supplier, ordered line quantities/units/unit prices/currency, delivery location, budget authorization, unique order identity and ordered/part_received/received/cancelled/closed state. Receipts identify order/line, accepted/rejected quantity, receipt date, actor, evidence and unique physical delivery reference. Cumulative accepted receipts and returns remain attributable; supplier invoices reference the order without pretending to be customer invoices.

## Workflows and Business Rules

Submitted amounts cannot change underneath a review. Approval checks and reserves budget in one mutation; pending/rejected requests do not consume it. Budget reductions cannot invalidate existing commitments or recorded actual spending. An authorized cancellation before closure releases a commitment once while retaining its decision history; it cannot erase already recorded spending.

Approved authorization retains its commitment until cancellation or recorded closure. Closure records actual cost in the same currency, purchase/receipt evidence, and releases any unused commitment; an overrun requires a separately authorized affordable increase before closure. Actual recorded spend continues to consume the budget. Remaining budget equals its configured total minus open commitments minus recorded actual spend; closing a request moves its amount between these categories atomically without double-counting. Corrections to closed spending require attributed linked adjustments and a fresh affordability check. Retried closure cannot release funds twice. This is spending evidence, not supplier payment.

Issue a purchase order only against authorized committed funds. Partial receipt records accepted/rejected quantities and updates cumulative order fulfillment once; a receipt cannot exceed ordered quantities without an explicit authorized order amendment and affordability check. A duplicate delivery reference returns its saved receipt. The receipt stays accepted with stock_posting_pending until its identified CanStock movement is confirmed; retries cannot receive the physical delivery again. Cancellation releases only the unfulfilled/unspent commitment under the recorded policy; accepted receipts, stock movements and evidenced spend survive. Stock returns/cost adjustments use linked reversals and evidence rather than deleting receipts.

Supplier invoice documents are staff attestations over frozen files, not automated extraction. Buyer intake freezes one invoice file per order under a globally unique source, transcribes the claimed invoice number, amount and issue date from its pages, and a budget manager accepts the exact confirmed claims into a Payable against closed spending or rejects them with a reason. A duplicate source fails instead of silently overwriting. Rejection is terminal and retains the frozen document; correction uses a fresh intake that preserves the rejected record.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Order navigation as My requests, then Purchasing for permitted buyer/approver/budget roles. Reviewer, approved-to-order and stock-posting queues belong within Purchasing; request/order/receipt details open contextually. Supplier/budget maintenance remains ordinary procurement, without another administration console.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| My requests — own requester index | Request form with purpose/category/amount/required-by Fieldset; own queue with state Badges, pagination and empty state | Edit own unsubmitted requests, submit a frozen amount/currency and follow the recorded approval outcome |
| Purchasing — authorized budget/review index | Location/supplier/category Select filters; budget Stat totals separating total, commitments, actual spend and remaining funds; review queue with state Badges, pagination and Drawer authorization detail with decision/order/increase/close/cancel/adjust Modals; scoped payable-export action (owning operation, no authored export button) | Maintain affordable budgets, decide assigned requests without self-approval, cancel/close or record linked adjustments through owning actions |
| Suppliers and approved orders — procurement view | Supplier Table with active/location/contact fields and pagination; approved-to-order List with state Badges; ordered-line quantity/unit/unit-price Table with accepted-vs-ordered Progress; payable Table with posting Badges | Maintain the canonical supplier register and issue an identified order only against committed authorization; order changes retain required affordability checks |
| Delivery and closure — contextual order/queue view | Outstanding quantities, accepted/rejected/returned goods, delivery evidence and stock-posting Badges; typed receive Fieldset; receipt/history List with pagination; invoice-document Table with frozen file, source, review-status Badges, claims and decision; amend/return/transcribe/accept/reject Modals | Receive partial deliveries once, retain linked returns/reversals, reconcile pending stock movements and record same-currency actual-cost closure; intake, transcribe and accept or reject invoice documents with exact-claim evidence |

On phones, place delivery identity, outstanding quantity and acceptance inputs together; allow labeled stacked budget/line rows. Distinguish loading, no own requests, empty review work and filtered-empty. Preserve unsaved request, rejection reason and receipt evidence after validation or stale outcomes. Refresh remaining funds after competing approvals; a changed submitted amount requires new review. Pending stock synchronization cannot invite receiving the same physical delivery again or claim posted stock. Closure moves commitments to actual spending once and releases only unused funds; cancellation cannot erase accepted goods/spend. Keep ordered/received/closed evidence distinct from supplier payment, and retain unauthorized-currency/quantity-overrun Alerts. Technical accounting/provider wiring and automatic vendor payment are excluded.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Requesters may remember own-request state; buyers/approvers/budget managers may save permitted location, supplier/category filters and queue starting view. Clear/reset restores accessible defaults; validate saved grants. Preferences cannot set budgets, reviewers, supplier scope, order quantities, stock postings or actual cost. Currency filtering never converts amounts; approval, receipt and closure remain canonical business actions with their recorded evidence. Queues apply the saved state/location/supplier filters as collection defaults with pagination and empty states.

## Interfaces and Integrations

Use D1 for budgets and requests.

Declare identified accepted-receipt/return posting to CanStock with SKU/unit/location/quantity and immutable receipt source. Co-deployed ledgers may commit locally together; otherwise persist pending projection and reconcile without assuming an atomic cross-database transaction. CanMaintain/CanStock reference supplier IDs here. Export payable/order evidence to an external accounting system if configured; automatic vendor payment remains deferred.

## Background Actions

Reconcile pending purchase-receipt/return stock projections with the same source identity and bounded retry. No automatic supplier payment or scheduled spending approval is implied.

## Error Handling

Reject mismatched currencies, self-approval, stale decisions, and commitments above remaining funds. Two approvals against the same remainder must produce only affordable commitments. Referenced approved requests cannot be hard-deleted to hide spending.

## Scope and Completion

Complete when concurrent approvals stay within budget, a changed submission requires a new review, and cancellation restores the exact commitment once. This records purchase authorization, not actual bank spending.

A manager can approve chairs for a location, record the actual same-currency cost and receipt, and release an unused remainder while paid spending still counts against the budget.

An approved order can arrive in two partial deliveries, each posts accepted quantity to stock once, and cancellation of the remainder cannot erase received goods or actual spend. Concurrent receipts cannot exceed the amended approved order quantity.

Frontend journey: a requester submits a purchase and the assigned approver reviews frozen amount/currency; a competing approval triggers a refreshed affordability Alert without losing the entered reason or exceeding budget.

Frontend journey: an order arrives in two deliveries; accepted quantities remain visible while stock posting is pending, and duplicate delivery returns its recorded outcome. Closing with evidenced actual cost releases only unused commitment; cancelling the remainder preserves received goods and spent funds.

## Composition and Ownership

Recommended placement: Finance. Own supplier register, purchase requests/orders/receipts and budgets. Compose with CanInvoice and CanExpense for navigation, but customer receivables, vendor purchase evidence and employee reimbursement remain separate ledgers. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Current authored draft — October 4, 2026

[CanPurchase.can](CanPurchase.can) and its [desired JavaScript target](CanPurchase.mjs) now append authorized `Increase` and `Amendment` evidence. Original request amounts and receipted line quantities/prices remain locked; derived authorization and ordered quantities include the additions, and staged budget/order invariants enforce affordability. Increase authority belongs to the location's budget manager and excludes the requester. Closing or cancelling closes the authorization with same-currency actual cost and evidence, releases only its unused commitment, and makes orders terminal. Partial cancellation leaves accepted receipt and spending evidence intact.

Physical delivery and return source identities replay their saved facts; differing quantity, parent, date or evidence fails. Returns retain the original receipt, queue a linked stock deduction, and never release money automatically. Stock sends use the immutable evidence revision rather than a bookkeeping row version. Reconciliation selects one receipt and one return per tick, with three attempts per admitted retry cycle; buyers can requeue the same exhausted evidence after investigation. Latest delivery completions and verified stock change events preserve confirmed outcomes.

`Payable` holds supplier invoice reference, amount/currency, date and evidence against closed spending. `PayableEvidenceV1.record` sends those facts with the frozen supplier/order/location identity and requires saved-outcome replay for the same source/digest. This authored draft includes configured accounting export and therefore requires a real `deployment.accounting` binding. A deployment without export omits that integration through ordinary Can source selection/edits; no optional runtime binding or automatic vendor payment is implied. Customer receivables in CanInvoice remain separate.

The direct purchasing queue preserves assigned-review and buyer access independently of budget totals. Own-request intake uses limited budget identity grants; supplier picker grants remain owned by the shared supplier package. Cross-location budget totals require complete dependency access and cannot show partial sums as whole-budget balances. Inline examples now cover increases, quantity amendments, partial delivery/replay, linked returns, cancellation retaining actual spending, and supplier invoice affordability.

The existing syntax prototype parses both sources, and Node parses both desired targets. These checks do not execute the operations, inline examples, D1 transactions, delivery/ingress adapters, accounting export or rendered interfaces. All target imports remain proposed unimplemented contracts.
