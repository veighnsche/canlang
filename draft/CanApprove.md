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

A null location explicitly denotes operator-wide documents. Site-scoped submit, coordinator assignment and reviewer reads check current workplace eligibility; the parent Document grant cannot expose metadata after a reviewer loses that location. The submitter keeps their own version history and can withdraw their own pending version after workplace loss. Both submission and reassignment require a distinct account with the actual current `approve.reviewer` role; an Employee's descriptive `role` text does not grant decision authority. Operator-wide documents still require that current reviewer role, without inventing a location requirement.

Every submitted immutable file gets a distinct Submission. Replacing a pending version withdraws it and cancels its due occurrence; an already decided version and its original file remain intact. Revision/file/note/due always lock, and finalized reviewer/email/assignment plus decision fields lock. A saved decision uses ordinary canonical operation replay; a new decision invocation against a finalized version fails. Document and Submission exports let explicitly authorized consumers reference these same owning records, without conferring document/file read access.

The existing scoped coordinator `assign` operation supplies recovery when a pending reviewer loses their role or site eligibility, including an overdue review. It requires the current document revision and a currently eligible replacement, preserves the original file, note and due date, increments assignment, records a fresh attributed reviewer notice, and replaces the revision-bound due occurrence at `max(now,due)`. It cannot reassign finalized decisions. Ordinary record history retains old/new reviewer and actor attribution; frozen Notice assignment/recipient plus created-by/time show which request was issued. No second assignment model or administrative bypass is introduced.

Reminder admission and request/reminder dispatch recheck the pending document revision, assignment, current reviewer role and workplace eligibility. Decision notices preserve the historical decision independently of later reviewer loss. Notification completion changes a child Notice, so recording a delivery outcome cannot stale the review deadline or change the approved/rejected file and evidence. Frozen recipient/subject/body, a once-associated delivery reference, and pending/succeeded/failed/unknown/skipped outcomes remain visible. Failed completion uses the canonical closed safe `DeliveryError {code:text,message:text}` with `result=null`; no retry policy is inferred from its code or message. Outbox retries retain the same logical notice and provider identity; uncertain delivery does not justify a duplicate business decision.

My submissions explicitly filters to the caller's own Documents even when the caller is a coordinator. The authorized review queue remains separate, due-ordered, with state/reviewer/location/category/overdue filters and an Overdue field. Version details retain file, reason, decision actor/time, ordinary history and attributed notice outcomes. English/Dutch labels and canonical page descriptors remain paired in source and desired JavaScript. Operation inputs use `assignee:user` so the current `reviewer(assignee)` role predicate cannot be shadowed by a same-named local input; the stored historical field remains `Submission.reviewer:user`.

## Focused correspondence evidence and remaining boundaries

The source and desired JavaScript contain eleven isolated tables with 47 rows, using distinct immutable named reviewer/coordinator/HR/ordinary-user recipes and model fixtures. The cases distinguish an actual reviewer grant from an Employee labeled “Reviewer”, current site eligibility from operator-wide scope, self-review, stale requests, overdue reassignment, frozen original approval/file, rejection reasons, revision-bound reminders, and all completion states. Matched and mismatched safe failed decision-mail completion preserve the approved file, reason, decision actor and time.

Three attached shared-state sequences contain 67 statements and 23 explicit canonical calls. They create Documents through `Document.create` and submissions through `submit`, rather than seeding fabricated decision histories:

- Rejection, replacement and approval keep both exact files, reasons, decision actors and separate decision notices; a coordinator cannot rewrite the rejected assignment.
- A failed replacement submission leaves the previous pending file/state intact; successful replacement makes the old open review conflict. A normal coordinator reassignment retains attributed request history, rejects the former reviewer's stale request and fresh unassigned attempt, and lets only the replacement reviewer decide. A separate ordinary user observes no Document/Submission records.
- Real `employee.deactivate` removes the assigned reviewer's workplace eligibility while their static reviewer role remains present. The normal coordinator reassigns the same immutable submission; an old assignment version conflicts, and the replacement reviewer approves without changing file/note/due.

Verification: `node --check` passes. The unchanged syntax parser accepts the production declarations and all isolated tables in a temporary projection that removes only the three sequence blocks. Full source fails at its first attached sequence (currently line 84), because this proposed DESIGN/GRAMMAR syntax is not implemented in the prototype parser. Descriptor-only construction validates fixture dependencies and the 11-table/47-row plus 3-sequence/67-statement/23-call structure without executing callbacks. Source/target checks compare every table input/expected value/error and each sequence call's canonical operation, explicit actor, normalized inputs, stale-version envelope, expected error, expected values and assertion arity. Manual inspection checks the viewer-filtered queries, pinned bindings, ordinary history, guards/locks, derived overdue value, forms and page descriptors.

These checks do not execute a compiler, stdlib, UI renderer, fixture runner, provider, scheduler, upload, replay or live authority race. The failed replacement step is a business-admission failure after a replacement file fixture exists; it is not an executed failed upload. The HR transition is real authored eligibility loss, not an executed role/team revocation. Named user role recipes remain immutable. Transport-level upload failure, browser draft retention/conflict navigation, saved-decision replay, live timer replacement and provider outcomes remain runtime verification boundaries.

Reviewer inputs currently use the canonical `user` reference with safe opaque presentation. The companion's recognizable eligible reviewer Select still needs an explicitly authorized candidate-read composition under the committed person-choice contract; current subject role checks do not enumerate people or disclose another user's email/private HR fields. Notice currently retains a transport reference/state mirror. Migration to the committed associated typed-delivery reference and authoritative safe completion-state descriptor is a separate focused application; the examples above describe the current owned handler's correlation behavior, not that migration.
