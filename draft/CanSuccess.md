# CanSuccess requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanSuccess.can](CanSuccess.can).

## Purpose and Adoption Goal

Help workspace account managers retain business customers by coordinating move-in, usage reviews, issues, and membership or agreement renewals. Adoption depends on a dated next action and a visible owner for each customer.

## Users and Permissions

Account staff see the customers they are authorized to manage; responsible managers own follow-up actions. Account notes and contact details are not exposed to arbitrary team members or to the customer by default.

## Data and Ownership

Account stores name, customer contact email, and team. Accounts have active/archived state, manager, renewal date, and change history. Milestones/follow-ups store assignee, due time, completion actor/time, and revision. Archived accounts retain their history but stop future reminders.

Record customer organization, serviced locations, onboarding/move-in milestones, contract or membership-term reference, manually entered renewal risk with reason, last review date, and attributed account notes. Track dated follow-ups separately from milestone completion.

Account records reference one CanCustomer organization/individual ID. Keep account-management fields here; billing contacts and company administrators are read from their source and are never inferred from the renewal owner.

## Workflows and Business Rules

Record explicit completion rather than treating a viewed notification as done. Adding a milestone changes the displayed denominator visibly. Reassigning an account transfers pending follow-ups to an active manager; an archived account's historical actions remain readable to authorized staff.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Customer success /customer-success is the account-manager sidebar destination; account details and customer/source links remain contextual authorized selections. This is ordinary account work, with no extra administration console.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| Account portfolio /customer-success | Customer/Account Lists and renewal-ordered Table; location/manager/window/risk Select, active/archive Badge and progress Stat with visible denominator. | Account CRUD and reassign require location/active-manager scope; billing/company authority never derives from ownership. |
| Account milestones and timeline | Account Card, notes, Milestone Table and Collapse for owner/milestone history, source agreement/membership references and risk reason. | Milestone CRUD and milestone completion are explicit owning actions; adding a milestone changes progress rather than rewriting completed work. |
| Dated follow-ups and overdue queue | Due/assignee/state Table with linked instructions, reminder delivery status and account context; date Fieldset for follow-up entry. | FollowUp CRUD and complete update revision-bound reminders; reading notices does not complete work and archive stops future reminders. |
| Authorized source summaries | Compact booking/support/term Cards with source timestamps and unavailable/stale Alert; links open only permitted source records. | Configured scoped reads or CanReport only; a renewal task cannot extend a paid term, settle an invoice or expose private contacts. |

Mobile Cards retain next action, owner, due date, manual risk reason and source freshness; business record forms use Fieldset drawers with focus return. Distinguish no active accounts, no overdue tasks, loading and missing integrations. Preserve notes/dates on validation or concurrent reassignment conflict, and display failed delivery without pretending the follow-up is complete. Reassignment refreshes pending ownership while keeping historical actors. Presentation language changes do not alter renewal scheduling timezone or customer evidence.

## Personal Configuration

Inherit [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Optional personal controls remember permitted manager/location/risk filters, renewal range or portfolio versus overdue view; the shared typed save path validates, persists and resets them. These filters do not share private notes, assign customers, change risk assessments, alter business reminder timezone or confer payment/company-admin permissions. Integration endpoints and source configuration stay developer-maintained.

## Interfaces and Integrations

Use D1 for records and EmailService for manager reminders.

Declare customer/term links and scoped booking or support-summary reads if installed. A recorded risk score is staff assessment, not a prediction inferred by the app, and a completed renewal task does not extend a paid term.

Use CanReport or scoped current term/billing reads for renewal work; overdue task completion cannot substitute for confirmed next-term payment.

## Background Actions

Schedule renewal reminders in the account timezone and follow-up reminders against their current revision. On reassignment or renewal change, invalidate old notifications. Show already overdue items in the queue rather than scheduling repeated reminders in the past.

## Error Handling

Explain invalid schedules and manager references. Completing or rescheduling a follow-up must update its reminder; show failed notification delivery.

## Scope and Completion

Complete when archived or reassigned accounts do not email obsolete managers, renewal changes replace reminders, and staff can find overdue incomplete actions.

An account manager can prepare a company's move-in, follow up an unresolved issue, and act before its renewal deadline while the real agreement/membership remains authoritative.

Frontend acceptance journeys:

- A manager prepares a move-in, adds a milestone and observes its progress denominator, then records a dated follow-up and explicit completion. The linked paid membership remains unchanged by that completion.
- Reassignment transfers pending work to an active manager and invalidates old reminders; archiving stops future notices. A failed delivery or stale source summary remains visible, while notes entered during a conflict are preserved for authorized correction.

## Composition and Ownership

Recommended placement: Customer and sales. Reference canonical CanCustomer records; own post-sale account milestones, risk assessments and dated follow-ups. Share customer navigation with CanCRM without overwriting deal history or granting renewal/payment authority. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Current authored draft contract

Current FollowUpDue occurrences carry both follow-up and account revisions. Completion cancels its key; follow-up edits and account edits/inactivation cancel and conditionally replace future occurrences. Reassignment performs the same scheduling explicitly because scenario writes do not rerun CRUD hooks. Dispatch checks current revisions, unfinished state and active account. Renewal notices occur at midnight on the recorded renewal date in the sponsoring location timezone; account creation/edit/reassignment arms only a future date and inactive/changed accounts cannot receive stale queued notices. Notices never renew an agreement. Exported work/work_detail reads use the actual account_manager and location completion guard.

### Renewal handoff and reminder draft completion

Agreement references are typed agreement terms and membership references are typed canonical memberships, constrained to the same customer (and agreement location). Contextual forms bind the existing agreement renewal and membership-term operations. Their original source permissions, file inputs, cycle checks and payment rules remain in force; an account-manager role does not grant renewal authority. Source records and term tables use their owning read grants and can remain unavailable to a manager without those grants. There is no invented booking/support summary: this draft uses the declared current agreement/membership records.

The portfolio shows milestone numerator and denominator, a separate overdue follow-up queue, the last review actor/time, and reminder delivery outcomes observed from the typed Mail.send association. Review records no renewal or payment. Completed milestones and follow-ups freeze their business inputs and completion attribution. Manager/assignee admission and notice dispatch check current role and location eligibility; historical records do not become invalid merely because a staff member later leaves.

Account edits, review and reassignment replace future reminders explicitly. Reassignment/account rescheduling currently handle at most 100 unfinished follow-ups atomically and reject excess without partial transfer; this is a declared draft work bound, not silent pagination. Each Notice record freezes destination/content/revisions with one typed Mail.send association; its displayed state reads the canonical pending/succeeded/failed/unknown/skipped receipt status (succeeded keeps the Delivered caption and means provider acceptance, never recipient reading), and the former pure receipt-copy callback is removed. Account-manager readers receive only the receipt identity/status, never payload or error contents; receipt progress performs no account write. Overdue work remains in the queue instead of rearming notices in the past. Inline review/completion examples are authored expectations; no delivery or renewal operation was executed. Bounded validation: the current parser rejects the canonical `delivery(Mail.send)` field type and the structured enum label on the model derive; a disclosed temporary projection replacing only that type with `text` and that label with its scalar caption parses the remaining source, checking surrounding syntax only, not receipt typing, label rendering, or runtime behavior.
