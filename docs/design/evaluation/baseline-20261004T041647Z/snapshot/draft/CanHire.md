# CanHire requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanHire.can](CanHire.can).

## Purpose and Adoption Goal

Help the workspace operator recruit receptionists, community managers, sales staff, and facilities technicians for specific locations. Adoption depends on usable vacancy intake and a private hiring pipeline.

## Users and Permissions

Recruiters manage vacancies and candidate records. Assigned interviewers can see the candidate and interview material they need; other team members do not automatically gain access to private recruiting notes.

## Data and Ownership

Vacancy stores title, description, and open/closed state; candidates store name and contact email. Candidate belongs to one vacancy with a unique normalized email within that vacancy and records application/stage history. Interview stores start/end, timezone, interviewer, cancellation state, and notes. Candidate records have developer-maintained retention configuration, defaulting to 180 days after vacancy closure; this does not require a recruiter retention-settings form.

Record vacancy location, employment type, required skills, hiring owner, publication state, and candidate application text plus optional immutable CV attachment. Retain interviewer feedback, rejection reason, and offer/hired outcome.

## Workflows and Business Rules

Closed vacancies reject new intake until reopened. One candidate may apply to different vacancies. Preserve previous stages when reopening an application. Interviews require valid ranges and a non-conflicting interviewer booking; cancellation releases that booking.

Candidates can submit to a published open vacancy through a verified intake flow and view their own submission status; recruiter entry records its source. Candidate withdrawal closes further interview work and invalidates reminders without inventing a retention override.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Navigation order is Careers, My applications for authenticated applicants, Hiring for recruiters, Hiring handoff for HR, then My interviews for assigned interviewers. Vacancy and candidate details open contextually from the indexes. Public discovery shows published open vacancies; candidates never receive private feedback, unrelated notes or staff privileges.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| Careers — public vacancy index | Location Select and title Input; vacancy Cards showing employment type, required skills and readable description | Open verified application intake only for a published open vacancy |
| My applications — own index | Table or compact List with vacancy, stage Badge, recorded public outcome and own attachment state | Read the own submission and withdraw through the current allowed workflow; contact matching alone cannot expose candidates |
| Hiring — recruiter index and stage queues | Location/stage filters, vacancy Table and candidate Lists grouped by stage; Fieldsets for vacancy and sourced intake | Maintain vacancies/candidate details, record source and decide stages through existing owning actions; reopening retains previous stages |
| Interview detail — contextual permitted view | Chronological interview List with start/end and timezone, state Badge, attachment links and restricted feedback Fieldset | Schedule against interviewer reservation authority, cancel/revise eligible work and record feedback only for the current assigned interviewer |

On narrow screens, keep application questions and CV attachment state in a single column; make interview date, timezone and current action visible before private history. Distinguish loading, no open vacancies, no own applications and no filter matches. Preserve application text and recruiter notes on invalid email/time or stale submissions. Show duplicate intake consistently for one vacancy while permitting different-vacancy applications. Pending/conflicting interviewer reservations and failed reminder delivery use separate Alerts, never a false confirmed appointment. Cancellation or withdrawal removes obsolete reminder/action controls. No extra recruitment admin console; retention/provider setup remains developer maintenance.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Remember permitted vacancy location, candidate-stage filter and chronological interview view only as personal display defaults. Interviewers may default to their assigned queue. Reset/clear returns to accessible unfiltered results, and invalidated saved grants are discarded. Preferences cannot publish vacancies, change stages, assign interviewers, amend retention, reveal private feedback or grant employee identity. Display the recorded interview timezone regardless of presentation language.

## Interfaces and Integrations

Use D1 for recruitment records and EmailService for candidate reminders.

Use R2 for bounded CV attachments and a declared interviewer reservation authority for conflict checks. A hired outcome can provide a scoped onboarding handoff; it does not automatically create staff privileges.

Developers maintain technical retention defaults in database/configuration. Recruiters author vacancies and handle candidates in their ordinary workflow; they require no technical policy/settings page.

## Background Actions

Send the interview reminder against its current revision and schedule. Rescheduling/cancellation replaces obsolete reminders. Remove candidate personal data and attachments when their declared retention expires.

## Error Handling

Explain invalid candidate addresses and interview times. Reject cross-team interviewer references and show failed reminder delivery.

## Scope and Completion

Complete when duplicate intake for one vacancy is handled consistently, interview scheduling prevents conflicts, cancelled reminders stop, and private notes stay restricted.

A candidate can apply for a location's reception role, a permitted interviewer can record feedback, and a recruiter can record a hire without leaking another vacancy's notes.

Frontend journey: a candidate finds an open location vacancy, submits verified intake with an optional CV and sees their own stage; a closed vacancy rejects submission while retaining entered application text.

Frontend journey: a recruiter receives a scheduling-conflict Alert and corrects the interval; the current interviewer records private feedback. Withdrawal disables obsolete work/reminders, and the candidate's refreshed view still excludes that feedback and other candidates.

## Composition and Ownership

Recommended placement: People development. Own vacancy/candidate/application/interview records and recruiting retention. Hired-candidate handoff creates a reviewed CanOnboard employee record; it does not itself issue staff roles or expose private interview notes to learners. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.


## Current authored draft contract

Vacancy close/reopen operations own `open`, `closed_at` and `retention_until`; ordinary vacancy edits cannot change them. Closing stores a deadline once from the developer-maintained `retention_days` default of 180 and blocks new intake; existing candidate work can continue under its own terminal-state guards. Scheduling/rescheduling cannot extend beyond a finite candidate deadline. Closing rejects an interview that would extend past the proposed deadline unless its reservation release is confirmed, including staged and unresolved-release work; it neither cancels everything nor silently extends retention. For ongoing work: reopen before expiry if the retained pipeline needs a new closing interval. `retain Candidate until=row.parent.retention_until` has no independent deadline while the vacancy is open, and covers the candidate subtree, private feedback, CV and retained content copies under the shared lifetime rules. Reopening affects only live data: admission expires due candidates first and never resurrects records awaiting physical disposal. Reclosing starts a new interval for still-live candidates. Cleanup/reference blocking, replay fences and external-provider copies retain the limits in DESIGN §7.1; there is no recruiter retention-settings form or authored cleanup loop.

Scheduling uses the actual `ScheduleV1.reserve`, `stage` and `release` declarations. A replacement has a fresh source and retains its confirmed predecessor until acceptance; conflicts and failures leave that predecessor intact. Cancellation, withdrawal, rejection and hire cancel current reminders and release active or pending bookings with revision-2 source fences. Release failures/unknown outcomes have a canonical retry action. Correlated late completions cannot revive cancelled interviews. Reminder delivery outcomes remain separate from reservation outcomes, and recording feedback does not invalidate the immutable interview schedule.

Recruiters restore rejected/withdrawn applications to their recorded prior active stage with an attributed correction reason. HR first creates or selects the single canonical `Employee` through `Employee.create`, then reviews the accepted candidate/account match, location and verification evidence through `hire.handoff`. That HR-only action calls exported `onboard.start` and records the employee reference once. It issues no team/application role, and copies neither candidate feedback nor recruiting documents into onboarding. An already linked applicant account must match; sourced intake without an account requires HR's explicit reviewed identity evidence.

Public and own indexes contain explicit publication/account filters even for combined-role users. HR sees only the candidate identity/handoff fields it needs. Interviewers use their own confirmed-interview queue rather than depending on an unreadable vacancy parent. Inline examples cover closure/reopening, stage restoration, staged replacement rejection, late-cancellation fencing and reviewed handoff. The `.mjs` companion is a handwritten desired target with unimplemented imports. Parser and Node syntax checks do not execute these examples or prove provider scheduling, privacy enforcement, cleanup or delivery behavior.
