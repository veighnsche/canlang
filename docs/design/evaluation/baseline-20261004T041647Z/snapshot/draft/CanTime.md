# CanTime requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanTime.can](CanTime.can).

## Purpose and Adoption Goal

Help workspace teams record time spent on customer services, facilities work, and location projects. Adoption depends on fast time entry and correct customer-billable totals.

## Users and Permissions

Members create and edit their own draft time entries; submitted/approved entries obey their frozen review state. Project managers set project rates and review team time; authorized corrections to another member's entries record who changed them and why.

## Data and Ownership

Project stores name and configured hourly rate/currency. Entry records project, member, description, server start/end instants, billable flag, and the rate/currency applicable to that entry. Snapshot the rate so future project changes do not reprice completed work.

Record project location/cost center, optional customer organization and repair/service reference, and review state. Manual entries have entered start/end instants with actor/reason and the applicable recorded rate rather than pretending the server observed the work.

Member work identity refers to the canonical active CanOnboard employee where staff time is tracked. Customer/project/invoice sources retain their own grants; an employee-directory read does not expose all team billable time.

## Workflows and Business Rules

Permit one running timer per member across team projects. Start uses server time; repeated start/stop commands return the same entry/result. A stop fixes end once. Manual corrections must have end after start and remain visible in history. Derive hours from elapsed instants, including overnight work.

Support manual entries for forgotten timers. A member submits a period's entries for manager review; submitted entries cannot change under the review. Rejection or authorized withdrawal returns them to draft with reason; approval freezes billable duration/rate. Corrections to approved/exported work create attributed replacement/adjustment evidence rather than silently changing an invoice source. Reject overlapping entries for the same person by default, with any permitted manager exception recorded.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Sidebar order is My time /time/mine, then Time review /time/review for project managers. Review and project-rate maintenance are normal project work; invoice/source details open contextually under their own grants.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| My time /time/mine | Inline start Fieldset and prominent active-timer Card; location/project/date/billable filters and own Entry Table with observed/manual origin, interval, duration, frozen rate/amount, state and currency. | start/stop/submit enforce one running timer, own active work identity and review locks; repeat stop retains the same end instant. |
| Manual entries and own weekly totals | Typed manual Fieldset with project/date/description/billable/reason controls; week/location/project filters and currency-separated Stat totals. | manual and permitted draft edits require valid nonoverlapping intervals; corrections cannot pretend server observation or reprice past work. |
| Time review /time/review | Scoped member/billable/location/project/date filters above the submitted-entry Table, decide/correct Fieldsets, rejection reason Alert and revision/history Collapse. | decide approves/rejects through current manager grants; correct records adjustment/replacement evidence for frozen/exported work. |
| Projects and approved export | Project Table/Fieldset with location/rate/active state; approved-entry export view grouped by currency and stable source identity. | Project CRUD preserves snapshots; bill hands approved charge to the owning invoice integration, without implying invoice issuance/payment. |

Mobile timer/entry Cards retain interval, origin, review state and currency; running elapsed display is explanatory, not a second timer mutation. Loading and no entries differ from stale/rejected review data. Keep manual values and correction reasons after validation/overlap errors. Pending export/delivery has its correlated status and source reference; refresh cannot imply successful invoicing. A rate change leaves earlier entries intact, overnight duration uses elapsed instants, and rejected/withdrawn entries return to draft only through attributed owning transitions.

## Personal Configuration

Inherit [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Optional persisted project/location/week/billable filters and compact versus grouped entry view are presentation preferences, validated against authorized projects and reset by the common own-user save action. They cannot start/stop a timer, change hourly rates, business timezone/currency, review state or invoice permissions. Project rates and billable decisions remain canonical business operations, with technical integration setup outside settings.

## Interfaces and Integrations

Use D1 for projects and entries and the shared timer primitive for start/stop behavior.

Declare approved billable-charge export to CanInvoice where configured. Stable entry/revision source identities prevent duplicate invoicing; an export is not itself invoice issuance or payment.

## Background Actions

No scheduled business actions. Running durations are calculated when displayed.

## Error Handling

Explain invalid rates and time ranges. Stopping an already stopped entry must preserve its recorded end time.

## Scope and Completion

Complete when concurrent start attempts cannot create two running timers, repeated stopping preserves end, an overnight entry has the right duration, and a later rate change leaves past amounts intact.

A technician can record a forgotten service visit, obtain approval, and export its frozen billable charge once while future hourly-rate changes leave it intact.

Frontend acceptance journeys:

- A technician starts a timer from two devices and receives one running entry; repeated stop preserves its end. A forgotten overnight visit uses manual entry with reason and receives the correct elapsed duration and origin label.
- A manager approves an entry, changes future project rates and exports its frozen charge once. A later correction preserves attributed adjustment evidence, while pending/failed handoff never renders invoiced or paid.

## Composition and Ownership

Recommended placement: Distinct reviewed-time module. Own time entry/review and frozen billable exports. Read the employee identity from CanOnboard and project/customer references from their owners; approved invoice sources are not writable time totals. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Concrete draft completion (2026-10-04)

The source now owns `Project`, employee-contained `Entry`, `PeriodReview` and immutable `Correction` evidence. `Employee.user` is unique in [the canonical employee package](shared/Employees.can); the unique unfinished Entry per Employee therefore enforces the member timer boundary within the selected team. Start returns the existing timer when its authored inputs match; a conflicting start rejects. Start uses server time, stop fixes the end once, and the shared owner transaction/replay contract must serialize concurrent admissions. No custom timer service or second CRUD path is introduced.

Manual intake, finished draft revision, timer stop and frozen correction all check the same authored `overlaps_work` derive. Intervals are half-open, so touching endpoints are allowed. A running entry remains open for overlap checks even if the incoming interval ends after the current clock. Only a project manager can allow a conflicting manual entry/revision/correction with a nonblank exception; the Entry stores the exception and its author. Superseded evidence is excluded from active work, rather than counting both the original and replacement. Draft revision retains the captured rate and changes the origin to entered work; the audit trail retains its earlier observed values. `service:field.Job?` links the real visit, with employee/location/customer consistency checks. Field's owning read grants still govern lookup and contextual details.

Period submission selects all completed draft entries wholly inside the entered instant interval, rejects running or boundary-crossing work, and freezes the selected list in one `PeriodReview`. The 500-entry bound rejects excess; it never silently drops entries. A manager must hold the current work grant for every selected location before approving or rejecting the entire review. Approval freezes entries; rejection and attributed member/manager withdrawal return them to draft with a retained decision, reviewer and history. The own-time page uses an explicit actor predicate even when that actor is also a manager. Project/location/week/billable preferences affect presentation only; completed own totals exclude superseded rows and keep money separated by currency. Weekly inclusion uses each entry's starting local date; it does not split or round an overnight interval.

Correcting approved/exported work retains the original interval and amount, marks that original superseded, and creates a separate draft replacement at the original frozen rate. The replacement requires its own period review. A correction cannot bypass an unresolved predecessor correction by creating another approved replacement. A never-exported original needs no financial handoff. An exported original uses the actual [invoice-owned `BillingV1`](CanInvoice.can) `cancel`, `refund`, `reconcile` and `settled` contracts, without a new adjustment API or writes to Invoice records.

A successful, source-correlated typed cancellation result in `pending`, `unavailable` or `released` proves the invoice owner installed its permanent source fence. Transport acceptance, failed delivery and unknown completion do not. This follows `invoice.source_cancel`, which writes `BillingCancellation` before its outcome. Time records that outcome's revision and blocks replacement billing until cumulative matching-amount settlement is at least that revision, with neither collection nor refund pending and collected equal to refunded. A `released` result with no invoice reference is the explicit absent-source case: its fence also rejects a late queued charge. Older snapshots cannot unlock billing. Verified later settlements retain their monotone revision and can restore uncertainty if needed.

The original source is fully neutralized before a new replacement source is charged. Collected funds require an explicit manager refund of the outstanding net amount; a fulfilled refund delivery alone does not prove those funds returned. A definite failed cancellation has `retry_cancel`. A new refund is admitted only after a definite completed outcome/newer settlement or a definite failure, with no financial attempt pending; unknown outcomes remain blocked for reconciliation. External or split-payment refunds may require invoice-owner finance evidence. This design can refund and recollect money for a correction; it favors one complete replacement workflow over cumulative delta accounting. Invoice cancellation checks gross receipts, so a fully refunded issued invoice need not report `void` or `released`; readiness instead requires the installed fence plus the current zero-net settlement. Export remains distinct from invoice issue or payment, and the UI keeps the canonical delivery/source references and correction statuses visible.

The companion [desired JavaScript](CanTime.mjs) follows DESIGN §13: one callable registry, canonical schemas/read grants/locks, actual trusted-handler metadata, typed scalar helpers, bounded owner-aware queries, `@canlang/ui` factories and deferred fixture/example recipes. Every generated import is a proposed unimplemented contract. Inline examples cover repeat stop/overnight money, overlap rejection and manager exception, whole-period submission/approval/rejection, frozen replacement evidence, and source export rejection for stale snapshots, pending collections or retained money. The original and replacement billing fixtures need distinct identities because they represent separate evidence, rather than alternate initial states of one record.

Validation run: `python3 tools/can_parser.py draft/CanTime.can` and `node --check draft/CanTime.mjs` passed; the JS target was formatted with the shared `oxfmt`. These are syntax checks. They do not resolve imports, type-check grants or queries, execute inline examples, implement concurrent D1 admission, or verify provider delivery/refund behavior. Those runtime contracts remain implementation work. Three complete JEV requests/responses and the disagreement review are retained in [the consultation evidence](../design/jev/time-completion-20261004/analysis.md).
