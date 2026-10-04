# CanExpense requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanExpense.can](CanExpense.can).

## Purpose and Adoption Goal

Help workspace employees claim approved travel between locations, emergency supplies, and other out-of-pocket operating expenses. Adoption depends on private receipt submission and finance knowing what remains to reimburse.

## Users and Permissions

Employees submit and read their own expenses; eligible assigned reviewers see and decide those submissions. Finance members record reimbursement. A claimant cannot approve their own expense, and ordinary team membership alone does not grant access to every receipt.

## Data and Ownership

Each expense has a business description and belongs to its claimant's team. Expense stores claimant, amount/currency, business date, receipt, assigned eligible reviewer, submission revision, and decision actor/time. Reimbursement records its external payment reference and date; it is distinct from an approval.

The location is the first-version cost center. Record expense category, business purpose and an optional external job or purchase authorization reference. That reference is evidence text, not an imported operation or an automatic permission grant. Keep reimbursement currency distinct from claim currency; first-version reimbursement evidence must match the claim currency.

## Workflows and Business Rules

Freeze amount and receipt when submitted. The reviewer approves or rejects that revision; a rejected claim can be corrected and resubmitted with its earlier decision retained. The correction stores an immutable link to the rejected claim; that claim can create one successor draft, which is edited through canonical CRUD. Current claimant location access is required. Submission requires the actual package reviewer grant, distinct claimant/reviewer accounts and current location eligibility for both. If a submitted reviewer loses that grant or eligibility, the eligible claimant can withdraw with a reason and create one correction draft with a new eligible reviewer. The withdrawn original keeps its locked amount, receipt and assignment; withdrawal is not a rejection or reviewer decision. An approved/reimbursed claim cannot use this recovery, and a stale or repeated withdrawal is rejected. Finance can mark an approved claim reimbursed once using payment evidence. Payment references are trimmed and checked across all team reimbursements under the owner transaction fence, not just under one claim. Use the unique bank transaction or statement-line reference, not a reused batch label. The amount/currency must match and the payment date cannot be later than today at the expense location. These are records of reimbursement, not an automatic bank transfer.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Declared sidebar pages are My expenses (`/expenses/mine`) for employees and Expense review (`/expenses/review`) for assigned reviewers/finance. Claims, receipts and the finance reimbursement queue stay contextual. Use daisyUI for ordinary employee/review/finance work.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| My expenses | Own-claim Table/List ordered by business date, status/location/category/date filters and create Fieldset for purpose, cost center, amount/currency, receipt and reviewer. | Existing claimant create/edit and submit operations require private ownership and an eligible distinct reviewer with the actual reviewer grant. Withdraw an unavailable submitted review with a reason; use the single-successor correction operation to choose another reviewer. Draft fields remain editable only under their existing guards. |
| Claim revision and receipt | Summary Card with frozen submission amount, receipt download and revision; Decision history Collapse showing reviewer, actor/time and rejection reason. | Receipt access follows document/claim policies. Correct/resubmit rejected or withdrawn claims through owning operations; old decisions remain tied to their submitted receipt and amount. |
| Assigned review | Claimant/status/location/category/date Select filters above a Table of eligible assigned submissions with claimant, location, category, date, amount/currency and state; reason Fieldset with decision Buttons. | Only the assigned reviewer decides the frozen revision; self-approval and stale revision edits fail server checks. |
| Reimbursement and accounting | Claimant/status/location/category/date filters, pending-approved Table, evidence Fieldset for external reference/date/amount and separate reimbursement Badge/history; authorized CSV export Button with receipt references. | Finance records evidenced reimbursement once, in the matching claim currency. Approval is not a bank transfer; unique payment references and finance authority remain enforced. |

Show empty own claims, no assigned submissions and no pending reimbursement separately. A failed receipt upload preserves draft inputs without showing a valid submitted receipt; retries never replace evidence for a past decision. Pending mutations disable repeats and retain revision/reference. A stale decision or duplicate-reference conflict produces an Alert with the authoritative result rather than a successful status edit. Preserve unsaved reasons/evidence; confirm discard. On narrow screens stack labeled claim Cards and Fieldsets, keeping claimant, currency, revision and receipt access readable. CSV availability and receipt links remain scoped; membership grants no colleague-receipt access.

## Personal Configuration

Inherit shared base settings in the own-user dialog. Remember a user's own/review queue filter and compact/comfortable expense-list presentation within scope. Preferences never change reviewers, receipt privacy, submission locks, currency or finance authority. No setup/admin tab is required.

## Interfaces and Integrations

Use D1 for expense records and R2 for receipts.

## Background Actions

None in the first version.

## Error Handling

Reject unauthorized receipt access, self-approval, and edits to a decided revision. Prevent duplicate reimbursement references. Show failed uploads without creating an apparently valid receipt or altering a past decision.

## Scope and Completion

Complete when private submissions reach an eligible reviewer, changed receipts require a new decision, and a reimbursement can be recorded once with evidence.

A technician can submit a travel receipt against a location, receive a reasoned decision, and see the separately evidenced reimbursement without other employees seeing the receipt.

Frontend completion additionally requires these journeys:

- A technician submits a private location travel receipt, sees a reasoned rejection, corrects it and reads both revision decisions; colleagues cannot download the receipt.
- Finance opens an approved claim, records matching-currency payment evidence once and exports authorized accounting references, while the claimant sees approval and reimbursement as distinct outcomes.

## Composition and Ownership

Recommended placement: Finance. Own private claimant submissions, expense decisions and reimbursement evidence. A shared finance UI or CanApprove review component cannot bypass receipt privacy, self-review restrictions or finance reimbursement authority. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Draft completion evidence

Source and desired JavaScript preserve the actual noncaller reviewer-role check, current claimant/reviewer workplace eligibility, frozen claim evidence and the reason-bearing withdrawal of an unavailable submitted review. Rejected and withdrawn originals retain their receipt, amount and reviewer, and can create one successor draft through the correction operation. Canonical draft CRUD permits choosing another reviewer and changing the successor receipt; submission rechecks current authority. Finance still records a matching-currency reimbursement separately, using normalized team-wide payment references and the actual finance caller in its server-owned evidence.

The nine inline tables contain 49 authored rows: valid distinct reviewer/finance accounts, active ordinary-worker denial, self-review, workplace eligibility loss, unavailable-review withdrawal, stale versions, repeated withdrawal, rejected/withdrawn correction, retained rejection evidence, duplicate references, mismatched amounts/currencies and future payment dates. No successor is seeded solely to imitate the result of correction: connected examples create it through the actual operation. Named account recipes preserve noncaller roles; an Employee's work-role label confers no reviewer grant. Isolated rows exercise provisioned current states. Three additional shared-state sequences specify 26 canonical calls across 57 call/binding/assertion steps: claimant submission → reviewer approval → finance reimbursement; reasoned rejection → single correction → a distinct receipt → resubmission and reimbursement; and actual `employee.deactivate` eligibility loss → denied review → withdrawal → one successor with a new eligible reviewer → approval and reimbursement. The recovery sequence checks both a captured stale version and a fresh repeated withdrawal, and repeats correction to verify the single-successor boundary. Newly created records are re-queried after mutation before the next version-sensitive call. Earlier committed steps and their receipt/decision evidence must survive each expected rejection.

The initial parser accepts the production declarations and all nine tables after removing only the three proposed sequence blocks from a temporary inspection copy. It rejects the full source at the first sequence block, as expected from the documented parser boundary; the new sequence grammar has been manually checked against DESIGN §5.1/§13. JavaScript syntax and focused source/target correspondence checks pass. These checks do not execute expectations, provision accounts or prove receipt/download privacy. There is still no specified canonical teams-operation signature for live declared-role revocation; fixed ordinary-user recipes demonstrate role absence, while only employee eligibility revocation is represented as an actual transition. Role-change journeys, the compiler/runner and runtime privacy checks remain unimplemented. The production policies retain claimant privacy and current assigned-reviewer/finance eligibility; rendering, file authorization and transaction fences remain proposed runtime contracts.
