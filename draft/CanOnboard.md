# CanOnboard requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanOnboard.can](CanOnboard.can).

## Purpose and Adoption Goal

Help workspace HR and location managers prepare new employees for reception, sales, community, and facilities duties. Adoption depends on a reusable checklist with clear responsibilities before the employee starts.

## Users and Permissions

HR coordinators create employee records, maintain checklists, and control document access. Employees see their own onboarding and complete assigned steps; ordinary team membership does not expose another employee's documents.

## Data and Ownership

Employee links a team member to a start date. Steps belong to an employee and store title, due date, assignee, optional document version, and completion actor/time. Assignee defaults to that employee. Referenced documents retain their access policy independently of copied download URLs.

Record home location, role, coordinator, checklist template/version, and task category such as equipment, induction, or account setup. Template copies become independent employee steps so later template edits do not alter an existing checklist silently.

The employee package owns the canonical employee work identity with stable operator ID, linked verified staff account, active/inactive employment state, start/end date, home location, manager and entered skills/role eligibility. Candidate records remain in CanHire; an accepted hire creates an employee through an explicitly authorized reviewed handoff. HR private documents and personal fields retain narrower policy than shared schedule identity.

## Workflows and Business Rules

Compute progress from active checklist steps, with zero for an empty checklist. Completion is an explicit assignee/coordinator action, separate from uploading a document. Adding or removing a step changes the denominator and remains visible in the checklist history.

Generate a role/location checklist once per onboarding operation; due dates derive from the entered start date and visible template offsets. Mark blockers with reason. Completion of an account-setup step is evidence of staff action, not an automatic grant of access to another app.

A hired outcome does not automatically create staff membership or privilege. HR verifies the work identity and an authorized owner separately issues functional/location access. Deactivation immediately denies new employee-only actions and emits identified scheduling/task/reception reconciliation; existing paid customer identity and historical work are not erased. A manager cannot use shared skill data to read HR documents.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Order navigation as My readiness, then Onboarding for HR coordinators. Employee/checklist/document details are contextual links, with HR document policies independent of shared work-profile visibility. Readiness and HR coordination remain normal workflows rather than an extra administration console.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| My readiness — own/assigned index | Due-ordered Step Cards with title, document attachment state, blocker Badge and completion actor/time | Open authorized attachments and complete only permitted assigned steps; uploading a document does not itself complete a step |
| Onboarding — HR index | Location/start-date/overdue filters, employee Table with active state and progress Stat; employee/start-checklist Fieldsets | Create the canonical employee through verified/reviewed ownership, generate the location/role checklist once and deactivate through the owning action |
| Checklist coordination — contextual HR view | Step Table with assignee, due date, category, blocker reason and history; attachment controls | Add/edit steps, capture blockers, reassign, complete/reopen under existing coordinator grants; denominator changes remain visible |
| Reusable templates — HR view within index | Template List, version/role/location fields and ordered template-step Fieldsets | Maintain templates and their steps; new copies become independent employee work without rewriting old checklists |

On narrow screens, place due date, blocker explanation and the next authorized action above secondary history. Distinguish loading, no assigned steps, zero-progress empty checklists and filtered-empty. Keep unsaved notes/template edits on validation or stale submissions; show progress only from saved active steps. Document Buttons must report loading/denial without exposing another employee's filename or reusable private URL. Incomplete uploads remain unusable, and an optional attachment failure cannot erase an independently saved completion. Show configured training/task handoff outcomes and deactivation reconciliation as pending/conflict where applicable; checklist completion never grants application roles. Candidate feedback stays in hiring, and shared employee skill/status reads never reveal HR documents.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Employees may remember due/open-step filters; HR may save an authorized home location, start-date range and overdue view. Preferences have clear/reset controls and current-grant validation. They cannot alter employee identity, active status, skills, role eligibility, assignee, checklist template or document policy. Those changes use the canonical HR/coordinator workflows. Personal preferences do not grant staff membership, and technical integration settings remain outside the onboarding interface.

## Interfaces and Integrations

Use D1 for records and R2 for onboarding documents.

Declare training-enrollment and task handoffs if configured, preserving external references and outcomes. Do not expose HR documents through a training or task link.

Expose scoped employee work-profile/status reads to CanShift, CanLeave, CanField, CanBook and CanTime, including version/freshness. Keep one employee source in the composed profile; a user ID or employee name in another app cannot establish active status or role eligibility.

## Background Actions

None in the first version.

## Error Handling

Reject unauthorized step/document access. Incomplete uploads are never downloadable attachments; failure to attach an optional document does not erase an independently saved completion.

## Scope and Completion

Complete when an employee can use their own checklist while HR can coordinate it, document links obey the same privacy rules, and added steps update progress predictably.

A new community manager receives the correct location checklist, can complete their own steps, and HR can see missing equipment or induction work before the start date.

A reviewed hire becomes one canonical employee and readiness checklist; deactivation stops new staff assignment without exposing candidate feedback or silently deleting published shifts.

Frontend journey: a new employee opens their location checklist on a phone, completes an assigned step and downloads only an authorized document; failure of an optional upload leaves separately saved completion visible.

Frontend journey: HR adds a step and sees the denominator/history change, reassigns a blocker and deactivates the employee. New staff assignment stops while scheduling reconciliation remains explicit, with previous work retained and private candidate/HR documents still restricted.

## Composition and Ownership

Recommended placement: People development. Own canonical employee work identity and onboarding steps/templates. Compose with CanHire and CanLearn; employee work-profile reads expose only necessary fields, and training enrollment does not inherit HR document access. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Current authored draft contract

The draft imports can_work explicitly and seeds the required Step category. HR can create templates and checklist steps through canonical CRUD. Templates have active availability; template edits and template-step create/update/remove advance the template revision while existing copied employee steps remain independent. Saved progress exposes completed/active step counts and the percentage, including zero for an empty checklist. Archive/history semantics remain canonical. No background notices are added because this first version specifies none. No training-enrollment or external task connection is configured, so the draft declares no imaginary handoff adapter. Hiring imports the canonical exported Template/start declarations for its reviewed HR transition.


The hiring transition uses the existing HR-only `Employee.create` workflow and unique employee account, followed by `hire.handoff` with identity-review evidence, account/location checks and a single canonical `start` call. The review does not grant staff membership/application roles or transfer candidate feedback/CVs. Existing `Employee.create` and `deactivate` grants and employee ownership are unchanged. HR has explicit owning template/template-step reads alongside the existing member/location predicate, so coordinators can maintain and select their templates without an unrelated work-profile grant. Checklist start requires a current team account. HR can amend checklist steps only for active employees and current team assignees; reopening a completed step also requires active employment and records its blocker reason. Inline start/reopen examples retain concrete authorization, inactive-template/employment and completion-evidence cases. The desired JavaScript exports canonical identities separately from callable handlers and preserves deferred fixture recipes; no compiler, renderer, stdlib, integration adapter or example runner is implemented by these drafts.
