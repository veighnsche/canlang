# CanApprove requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanApprove.can](CanApprove.can).

## Purpose and Adoption Goal

Help workspace managers review fit-out plans, signage, supplier documents, and operating procedures before they are used at a location. Adoption depends on knowing exactly which document was approved and what a rejection requires.

## Users and Permissions

Submitters access their own documents; eligible assigned reviewers access their review queue. Coordinators manage assignments. Default self-review is forbidden, and files obey document-level access rather than being readable by every team member.

## Data and Ownership

Document stores title, team, and submission history. Each submission refers to an immutable file version and stores submitter, assigned reviewer, and decision actor/time. Earlier submissions and decisions remain linked when a corrected file is resubmitted.

Record document category, location or operator-wide scope, related supplier/customer/project reference, submission note, review due date, and decision comment. Rejection requires a reason; an approval may include recorded conditions.

## Workflows and Business Rules

Approve or reject exactly the submitted revision. Replacing a file during review withdraws that submission and creates a fresh review request. A reviewer action against the old revision must fail; a decision cannot be retained while silently swapping its file.

Coordinators assign or reassign one eligible reviewer and retain assignment history. Submitters may withdraw pending submissions. Approval records the document decision only; it does not automatically authorize spending, access, or construction.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Declared sidebar pages are My submissions (`/documents`) and Review queue (`/documents/review`) for eligible audiences. Version details and coordinator assignment stay contextual within those queues. Use daisyUI; document decisions remain ordinary review work without an administration console.

| Page or logical destination | Components and content layout | Canonical actions and conditions |
| --- | --- | --- |
| My submissions | Table/List of title, location, category, revision, reviewer, due date and state; status/reviewer/location/category/overdue Select filters and title Input; submission Fieldset. | Create/edit own document records and submit a file through existing operations; only pending submissions offer withdrawal. |
| Version and decision detail | Card with immutable version identifier, preview/download Button and submission note; Tabs or Collapse sections for earlier submissions, assignment history and decisions. | File access obeys document policies; approval conditions and rejection reasons stay beside the exact downloaded revision. |
| Review queue | Due-ordered Table of assigned submissions with overdue Badges, revision/file links and state filters; decision Fieldset with reason and approve/reject Buttons. | Only the eligible currently assigned reviewer decides; self-review and old-revision decisions fail server checks. Rejection requires its reason. |
| Assignment | Within the review queue, a focused Card with current reviewer, eligible reviewer Select and attributed assignment List. | Coordinators assign/reassign under existing scope; assignment visibility does not confer decision authority. |

Show a clear empty own-submission or assigned-review state. Mark uploads, decisions and notices independently: a failed upload leaves the previously submitted file intact; a saved decision may still have a notification failure. Disable repeated decision submission while pending, retain the original result on retry, and show a changed-revision Alert with a link to the current submission instead of applying the old decision. Preserve draft notes/reasons after errors and confirm before discarding them. Narrow screens stack metadata and actions without hiding revision, deadline or rejection comment.

## Personal Configuration

Inherit the shared own-user dialog and base settings. A submitter or reviewer may remember their default queue filter and whether version history opens expanded. Apply preferences only to currently authorized records; they cannot change reviewer eligibility, document visibility, decision notifications or due-date rules. No separate app settings page is required.

## Interfaces and Integrations

Use D1 for metadata, R2 for files, and EmailService for decision notifications.

## Background Actions

Send the decision email on approval or rejection.

Send a submission notice to the assigned reviewer and a revision-bound due-date reminder while the review remains pending.

## Error Handling

Reject changed-revision or self-review decisions. A failed upload cannot replace the submitted file. Retrying a saved decision returns its original result and does not create a second decision message.

## Scope and Completion

Complete when a changed file cannot inherit an old approval, only the current assigned reviewer decides, and decision evidence remains tied to the downloaded version.

A location manager can submit a signage plan, understand a rejection, replace the file, and obtain approval of the replacement with both decisions retained.

Frontend completion additionally requires these journeys:

- A submitter receives a reasoned rejection, replaces the file, and reads both decisions beside their respective downloadable versions.
- A reviewer holding an older submission open receives a revision-conflict response after replacement, then opens the new request; a coordinator's reassignment leaves visible history and removes the old reviewer's decision control.

## Composition and Ownership

Recommended placement: Document review module. Own submitted immutable document versions and their decisions. Reuse review presentation where useful; expense, budget and grant approvals remain guarded mutations of their owning domains. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Authored revision and notice contracts

A null location explicitly denotes operator-wide documents. Site-scoped coordinator and reviewer reads check current workplace access; the parent Document grant can no longer expose metadata after a reviewer loses that location. The submitter keeps their own version history. Assignment accepts a different person with current site access (or an operator-wide candidate); the reviewer role and current assignment remain mandatory when deciding.

Every submitted immutable file gets a distinct Submission. Replacing a pending version withdraws it and cancels its due occurrence; an already decided version and its original file remain intact. File fixture recipes now cover replacement, preserved approval, stale revision, self-review and rejection-reason cases without invented file literals. Document and Submission exports allow explicitly authorized consumers to reference these same owning records.

Assignment has its own revision. Reassignment increments that revision, records a fresh reviewer notice and replaces the due occurrence, including an already overdue review. Reminder admission and dispatch recheck the current pending revision and assignment. Notification completion changes a child Notice, so recording a delivery result cannot accidentally stale the review deadline. Frozen recipient/subject/body and pending/succeeded/failed/unknown/skipped outcomes remain visible alongside the exact submission. Outbox retries retain the same logical notice and provider identity; an uncertain send does not justify a duplicate business decision. Source examples and desired JavaScript are authored contracts; checks do not execute them.
