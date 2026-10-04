# CanLeave requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanLeave.can](CanLeave.can).

## Purpose and Adoption Goal

Help workspace staff request time off while location managers see approved absences and plan reception, sales, and facilities coverage. Adoption depends on correct allowance calculations and clear approvals.

## Users and Permissions

Employees submit/read their own requests and withdraw pending ones. Eligible assigned approvers decide requests without self-approval. HR manages allowances; a shared absence calendar reveals dates, not private leave reasons.

## Data and Ownership

Allowances are unique per employee, year, and leave bucket. Leave records date range, kind, working-day count, reviewer, and pending/approved/rejected/withdrawn/cancelled status. The configured working calendar defines weekdays and holidays. Twenty days and the vacation bucket are defaults only when HR explicitly creates an allowance; requesting a category never creates an entitlement. Calendar-owned Category policy maps each allowed leave kind to a nullable allowance bucket. Configure sick/personal with no charge, or explicitly map them to their own or another allowance.

Record employee home location, leave reason visible only under the private policy, and decision/cancellation reason. Working calendars and allowances are configured by the employee's assigned policy, allowing different locations to use different holidays.

## Workflows and Business Rules

First-version requests cover whole working days with inclusive dates shown to users. Count using the employee's working calendar, not raw elapsed UTC time. Sick/personal leave is tracked separately and does not consume vacation unless configured. Split cross-year requests against the applicable allowances. Approval atomically reserves available days; authorized cancellation restores them once.

## Pages and Interactions

Use the [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Order navigation as My leave, Leave review for eligible approvers/HR, then Absence dates for permitted coverage planning. Request details are contextual links. HR allowance work stays ordinary; shared absences exclude private reasons.

| Page or destination | daisyUI layout and content | Canonical actions and conditions |
| --- | --- | --- |
| My leave — employee index | Date/bucket Fieldset, recorded working-calendar explanation and allowance Stat totals; own request history Table with status Badge | Preview inclusive whole working days, cross-year portions and remaining allowance before requesting; withdraw own pending requests |
| Leave review — assigned approver queue | Request Table with authorized private reason, recorded calculation, decision history and synchronization Badge; reason Input | Decide only the assigned eligible request without self-approval; authorized cancellation restores the recorded balance once |
| Allowances — HR view within review | Employee/year/bucket Table with configured and remaining days; authorized allowance Fieldsets and export Button | Maintain allowance records and export by year/bucket under HR policy; a configurable vacation default is not universal entitlement |
| Absence dates — scoped coverage index | Location/date Select filters and date-grouped List or Table showing accepted dates and coverage needs | Read accepted absence intervals; open only permitted context, excluding private reasons and HR identity fields |

On mobile, show requested dates, bucket, counted days and split-year allocation before submit. Loading a calculation must remain distinct from a valid zero; distinguish no own requests, no review work and no filter matches. Preserve entered reason/dates on invalid or stale submissions and refresh the available balance after concurrent decisions. Conflicting published shifts and delayed/conflicting schedule synchronization remain visible Alerts for authorized resolution, not silently deleted assignments. An old request continues to show its recorded timezone, category-to-allowance mapping and working-date portions after policy changes. Calendar, working-day and category edits advance the calendar revision. Shared absence cards remain free of private reasons even when the same user can access a separate review view. Stale decisions cannot approve or consume days.

## Personal Configuration

Inherit shared account/language/appearance persistence, validation and reset. Employees may remember the allowance year/bucket view; approvers/HR may save an authorized location and pending-review filter; coverage viewers may remember a permitted date range. Clear/reset restores accessible defaults; validate saved grants. These choices cannot change the employee's working calendar, holidays, allowance, reviewers or accepted dates. Date display must preserve the inclusive whole-day meaning across languages.

## Interfaces and Integrations

Use D1 for allowances and requests and shared team authentication.

The selected StaffScheduling composition uses the existing ScheduleV1 absence commitment interface to inform CanShift availability; it does not add a second absence ledger. Approval of leave must flag conflicting published shifts for scheduler resolution; it cannot silently delete them. Independently deployed apps expose delayed/conflicting synchronization status.

Read canonical employee status/home-location/calendar references from CanOnboard and publish accepted absence intervals to the single schedule authority. Neither the absence nor roster UI duplicates HR identity or reveals private leave reasons to dispatchers.

## Background Actions

None in the first version.

## Error Handling

Reject reversed ranges, overlapping active leave, insufficient configured allowance, and unauthorized decisions. Stale simultaneous approvals must not consume the same remaining days. Preserve the request's recorded calendar calculation if the calendar is later edited.

## Scope and Completion

Complete when weekend/holiday and cross-year requests count correctly, concurrent approvals cannot overspend an allowance, cancellation restores balance once, and reasons remain private.

A receptionist can request holiday against their working calendar and a location manager can identify the resulting rota conflict without disclosing a private leave reason.

Frontend journey: an employee enters a holiday spanning two years, sees counted working days and per-year allowance portions before submission, and corrects a rejected range without losing their reason.

Frontend journey: an approver encounters a stale balance after a competing approval and sees an affordable refreshed outcome. A location manager then sees accepted absence dates and a rota-conflict Alert without receiving the employee's private leave reason; cancellation restores allowance once.

## Composition and Ownership

Recommended placement: Staff scheduling. Own allowance/request calculations and private leave decisions. Share the employee identity and accepted absence authority with CanShift; the roster receives unavailable intervals, not private reasons. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Draft completion and implementation limits

The draft declares a viewer-scoped preview of counted working days, yearly portions and owned balances before submission. Charged and uncharged requests retain the same date portions; only non-null allowance references participate in approval balance checks. Assigned reviewer portion reads are scoped to that reviewer and current work grants. The absence page and its coverage read grant accept approved requests only, with location/dates/state and no private reasons; even HR uses that narrowed page query. HR can maintain categories, days and explicit allowances from the review page.

Approval persists its reserve delivery reference and a schedule revision independent of record versions. Cancellation advances that revision, resets absence synchronization and retains release delivery state. Both typed completions and changed events check source/revision or the current delivery reference; a late confirmed outcome cannot revive cancelled leave. Uncertain/failed release can be retried with the retained source fence. This remains eventual coordination with CanShift: local cancellation restores allowance once, while release state remains visible until the schedule authority acknowledges it.

Inline examples cover cross-year/weekend calculation, missing configured dates, uncharged sick leave, preview, sufficient/insufficient approval balance, single cancellation and terminal cancellation against late schedule results. Their JavaScript targets contain deferred fixture recipes and typed observation callbacks, not a provisioning implementation or runner. The Python Can parser and `node --check` check syntax only. The compiler, standard library, UI factories, owner transaction/locking implementation, adapters and executable example runner remain unimplemented; the imports in CanLeave.mjs are proposed contracts.
