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
| My submissions | Table/List of title, location, category, revision, reviewer, due date and state; status/reviewer/location/category/overdue Select filters and title Input; submission Fieldset. Submission Fieldset gains typed controls: input title/category/subject/email on intake; file_input file, textarea note and input reviewer_email on submit (due stays a generated datetime control); version history is a collapse honoring the versions-open preference; each version row shows badge state, status overdue and a direct withdraw button; collections carry Pagination. | Create/edit own document records and submit a file through existing operations; only pending submissions offer withdrawal. |
| Version and decision detail | Card with immutable version identifier, preview/download Button and submission note; Tabs or Collapse sections for earlier submissions, assignment history and decisions. | File access obeys document policies; approval conditions and rejection reasons stay beside the exact downloaded revision. |
| Review queue | Due-ordered Table of assigned submissions with overdue Statuses, revision/file links and state filters; decision and assignment modal dialogs opened by button opens=, each with an inline form (checkbox approve + textarea reason; input email). Literal approve/reject buttons are NOT authored: a button carries exactly one binding and cannot set the approve input value; the checkbox + generated submit is the faithful expression. | Only the eligible currently assigned reviewer decides; self-review and old-revision decisions fail server checks. Rejection requires its reason. |
| Assignment | Within the review queue, a focused Card with current reviewer, eligible work choices and attributed assignment List. Coordinator assignment uses the assignment modal plus the unchanged reviewer_choices candidate list with candidate-bound assign forms. | Coordinators assign/reassign under existing scope; assignment visibility does not confer decision authority. |

Show a clear empty own-submission or assigned-review state. Mark uploads, decisions and notices independently: a failed upload leaves the previously submitted file intact; a saved decision may still have a notification failure. Disable repeated decision submission while pending, retain the original result on retry, and show a changed-revision Alert with a link to the current submission instead of applying the old decision. Preserve draft notes/reasons after errors and confirm before discarding them. Narrow screens stack metadata and actions without hiding revision, deadline or rejection comment. No countdown is authored for due dates (datetimes, not remaining durations). Changed-revision conflict navigation stays a shared runtime failure state, not an authored alert.

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

Reminder admission and request/reminder dispatch recheck the pending document revision, assignment, current reviewer role and workplace eligibility. Decision notices preserve the historical decision independently of later reviewer loss. The owner-local committed `Notice.created` event reloads the current Notice and enqueues its frozen recipient/subject/body only while no receipt is associated. Notice has no public create operation; scenario `create Notice` effects publish the committed record event rather than invoking a nonexistent CRUD create hook. Replayed events with an existing association do not enqueue again. The original domain operation remains the source of Notice created-by/time attribution.

Notice stores a nullable `delivery(Mail.send)` association, locked once assigned. Its displayed state derives from that receipt; null truthfully means no request is associated yet, while pending/succeeded/failed/unknown/skipped describe the associated request. Mutable receipt progress does not mutate Notice or Submission versions, rerun domain hooks, stale the review deadline, or change the approved/rejected file and evidence. The former completion handler only copied transport status, so it is removed; no business transition callback is lost. An unrelated or older receipt's failure cannot change the selected association's state. Existing notice audiences retain domain fields and safe receipt ID/status through exact grants; provider result/error and request internals are not newly disclosed. Canonical safe failed recipes retain `result=null` and the closed `DeliveryError {code:text,message:text}` without granting those private leaves or inferring retry policy. Outbox retries retain the same logical notice and provider identity; uncertain delivery does not justify a duplicate business decision.

`reviewer_choices(document)` is an ordinary read operation, available to the submitter or a current scoped coordinator. It queries the existing Employee owner's viewer grants, never an authentication directory or authority-mode people list. Candidates are active Employees with the actual current `approve.reviewer` role, exclude both caller and submitter, and for a site document require current work eligibility there. Work name, full user reference, descriptive work role and home provide readable disambiguation; two “Alex” accounts remain distinct, and a missing work name falls back to its opaque user reference. The descriptive “Reviewer” work label grants no role. Candidate-bound submit/assign forms pass the actual `Employee.user` value and retain the same canonical operation guards. The original opaque user inputs remain available for operator-wide or nonstaff callers without candidate-source grants; an empty authorized work list does not narrow those existing role-only operator-wide admissions. Context or authority changes rerun the query and server guards.

My submissions explicitly filters to the caller's own Documents even when the caller is a coordinator. The authorized review queue remains separate, due-ordered, with state/reviewer/location/category/overdue filters and an Overdue field. Version details retain file, reason, decision actor/time, ordinary history and attributed notice outcomes. English/Dutch labels and canonical page descriptors remain paired in source and desired JavaScript. Operation inputs use `assignee:user` so the current `reviewer(assignee)` role predicate cannot be shadowed by a same-named local input; the stored historical field remains `Submission.reviewer:user`.

## Focused correspondence evidence and remaining boundaries

The source and desired JavaScript contain twelve isolated tables with 59 rows, using distinct immutable named reviewer/coordinator/HR/ordinary-user recipes and existing model fixtures. The cases distinguish an actual reviewer grant from an Employee labeled “Reviewer”, current site eligibility from operator-wide scope, self-review, stale requests, overdue reassignment, frozen original approval/file, rejection reasons and revision-bound reminders. Reviewer choices cover equal and absent work names, noncaller/non-submitter selection, inactive candidates, a currently scoped coordinator, unauthorized actors, and a nonstaff operator-wide caller's truthful empty viewer result. Bound delivery recipes cover every receipt status plus the unassociated null state; failed decision delivery preserves the exact approved file, reason, actor and time. An unrelated failed receipt is present while the selected pending receipt remains pending. Recipe snapshots are test inspection evidence, not a simulated provider completion or proof of viewer serialization.
Three attached shared-state sequences contain 73 statements and 25 explicit canonical calls. They create Documents through `Document.create` and submissions through `submit`, rather than seeding fabricated decision histories:

- Rejection, replacement and approval keep both exact files, reasons, decision actors and separate decision notices; a coordinator cannot rewrite the rejected assignment.
- A failed replacement submission leaves the previous pending file/state intact; successful replacement makes the old open review conflict. A normal coordinator reassignment retains attributed request history, rejects the former reviewer's stale request and fresh unassigned attempt, and lets only the replacement reviewer decide. A separate ordinary user observes no Document/Submission records.
- Actual `reviewer_choices` calls before and after real `employee.deactivate` remove the unavailable account from choices while retaining the replacement. Deactivation removes the assigned reviewer's workplace eligibility while their static reviewer role remains present. The normal coordinator reassigns the same immutable submission; an old assignment version conflicts, and the replacement reviewer approves without changing file/note/due.

Verification: `node --check` passes. The prototype syntax parser rejects the settled `delivery(Mail.send)?` field type at line 14 before it reaches attached sequence syntax. With only that field type substituted, the first sequence is independently rejected at line 120. A disclosed temporary structural projection substitutes only that field type with `text?` and removes the three sequence blocks; production declarations, canonical delivery recipe syntax, viewer query, UI composition and all twelve tables parse there. Descriptor-only construction validates fixture dependencies and the 12-table/59-row plus 3-sequence/73-statement/25-call structure without executing callbacks. Source/target checks compare every table input/expected value/error and each sequence call's canonical operation, explicit actor, normalized inputs, result binding, stale-version envelope, expected error, expected values and assertion arity. Focused preservation checks keep the submit/assign/decide/withdraw/remind implementations, immutable Submission declarations/locks and both page descriptors unchanged. Manual inspection traces the current-record enqueue guard, already-associated replay, failed unrelated receipt, null-before-enqueue state, candidate viewer grants and read-to-mutation eligibility fence.

These checks do not execute a compiler, stdlib, UI renderer, fixture runner, provider, scheduler, upload, replay or live authority race. The failed replacement step is a business-admission failure after a replacement file fixture exists; it is not an executed failed upload. The HR transition is real authored eligibility loss, not an executed role/team revocation. Named user role recipes remain immutable. Transport-level upload failure, browser draft retention/conflict navigation, saved-decision replay, committed-event dispatch, live timer replacement and provider outcomes remain runtime verification boundaries. Leaf grants additionally require eventual executable checks that denied receipt result/error cannot serialize, aggregate or enter a filter, and that status observation fences mutable receipt progress; the inspection assertions above do not establish these runtime guarantees.

Initial whole status/result/error selectors reduce six complete delivery recipes to three: one varying review request, an independently identified detached failed review request, and one different frozen decision request. Each keeps its complete normalized request; pending/null/null defaults are omitted. The full combined envelope is validated before protected receipt provisioning. All eight receipt rows retain their independent expected outcomes, including no association and immutable approved evidence. The detached failure keeps its distinct identity rather than being merged into the current pending receipt. No detached-handle constructor, test-write operation, copied business model or dispatch framework is introduced.

Normalization alone reduces Can source from 31,350 to 31,169 UTF-8 bytes (181 bytes), so declaration count is not a dramatic token-saving claim. Production source after test erasure and the desired JavaScript production prefix remain byte-identical to the captured baseline. Every one of the 59 input/expected/error tuples still corresponds, every original expected callback/error is unchanged, and all three sequences remain intact. Node syntax and fixture dependency/direct-selector closure checks pass. Associated-delivery metadata, observation and candidate composition remain desired generated contracts, not implemented APIs.
