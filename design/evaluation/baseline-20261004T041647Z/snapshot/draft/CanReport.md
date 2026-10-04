# CanReport requirements

Inherits [canlang requirements](../REQUIREMENTS.md), [workspace operator context](WORKSPACE_OPERATOR.md), and [portfolio composition](PORTFOLIO.md). Companion draft: [CanReport.can](CanReport.can).

## Purpose and Adoption Goal

Provide a scoped operational reporting package for workspace managers and finance. Adoption depends on reproducible location utilization, paid revenue, receivables, renewals, and service-backlog measures rather than browser tracking counts.

## Users and Permissions

Managers read only permitted locations and metrics. Finance grants govern revenue/receivable views; HR and private customer records retain separate restrictions. A report role cannot grant underlying records or expose private values through grouped totals. Customer reports, where exposed, are limited to their explicitly authorized organization records.

## Data and Ownership

Report definitions record metric, selected location/time range/timezone, currency/unit, inclusion rule, source/version checkpoint, generation time, and freshness/completeness state. Sources remain authoritative; report caches or aggregates never become editable booking/payment/employee records. Imported source entries carry stable IDs/revisions and reversal links. All-location reporting uses a declared display timezone with each source location retained.

## Workflows and Business Rules

Booked utilization is confirmed workspace resource-minutes intersecting saleable intervals divided by the configured saleable resource-minutes in the same range; exclude cancelled/expired holds and declared closed/downtime intervals, and show numerator, denominator, excluded booked minutes conflicting with closure/downtime, and unavailable source data explicitly. A zero saleable denominator displays not-applicable, not an exact zero utilization. Pooled spaces use seat-minutes for both quantities and are not averaged together with private-room minutes. Actual occupied duration uses recorded check-in/out, labels still-open intervals provisional, and is distinct from booked utilization.

Paid revenue here means authenticated received customer funds minus confirmed refunds in the selected receipt/refund period, grouped by currency; label it cash receipts, not statutory revenue recognition. Receivables use an as-of invoice balance with payment/credit revisions applied once. Report membership renewals by term end, paid/unpaid upcoming terms, and cancellations; renewal task completion is not paid renewal. Service backlog uses authoritative open repair/job states and due dates. Deduplicate source updates and recompute or reverse changed contributions without adding unlike currencies or duplicate customer IDs.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Operational reports is the single sidebar destination /reports for authorized managers; finance, HR and organization grants further restrict metrics and source records. Metric sections are local Tabs, not invented settings or report-definition pages.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| Report selection and run history | Definition List with inclusion rule/unit/display timezone; location/date/currency Fieldset and prior-run Table showing generation/checkpoints. | refresh requests a bounded projection; measure reads it. Select existing definitions only; neither action changes source business records. |
| Booked and recorded occupancy | Stat numerator/denominator plus Table of room-minutes or seat-minutes, closure exclusions, conflicting booked minutes and provisional open occupancy. | Authorized source drill-down/export; zero saleable denominator is not-applicable, never exact zero; pool and room units remain separate. |
| Cash receipts and receivables | Currency-separated Stat/Table of received funds, confirmed refunds and as-of invoice aging, with source revisions. | Finance-scoped reads/export recheck source grants; booked value and browser conversion events cannot stand in for receipts. |
| Renewals and service backlog | Upcoming paid/unpaid terms, cancellations and repair/job due-state Lists; fresh/lagging/partial/unavailable Badge with explicit omissions. | Only authorized source destinations open; task completion cannot create a paid renewal or repair completion. |

Table rows collapse to labeled Cards on mobile while retaining checkpoint, currency/unit and provisional flags. Loading does not replace the last run with zeros; empty source-backed data differs from missing/unsupported data. Show refresh pending/failure and retain selected filters during correctable errors; a later response cannot silently overwrite a newer selection. Stale checkpoints and incomplete reversals remain visible. CSV exports carry the same source/field scope and completeness indicators; unavailable drill-downs offer a safe explanation without disclosing restricted records.

## Personal Configuration

Inherit [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration) for account/security, language and appearance with actual scoped persistence, validation and reset. Optional personal preferences remember an authorized metric tab and location/date/currency filters; they do not edit metric definitions, inclusion rules, source checkpoints, display timezone or permissions. No report configuration/editor/admin console is added. Source connections and refresh policy remain developer-maintained.

## Interfaces and Integrations

Compose inside an operator app using canonical model reads where records are co-deployed, or configure scoped source read/export capabilities for CanRent, CanMember, CanInvoice, and CanMaintain/CanField. Each returns source checkpoint, timestamps, revisions, and completeness, not just anonymous totals. CanStats owns website traffic/observed goals and must not supply confirmed payment or booking evidence.

Developers maintain report definitions, source connections and refresh configuration directly outside the product UI. Viewers receive scoped reads/exports, not a report-definition or permission-administration editor.

## Background Actions

Refresh bounded report projections at a configured interval or on source changes, with stable ingestion identities and backfill/reconciliation after lag. Expire cached exports under their configured retention. No report refresh may alter a booking, outstanding balance, membership, or maintenance decision.

## Error Handling

Never display unavailable/partial sources as an exact zero or silently include an unauthorized location. Reject inconsistent currency/time boundaries and expose stale checkpoints or incomplete reversal processing. Drill-down authorization is rechecked even when a cached aggregate was previously readable.

## Scope and Completion

A location manager can reproduce a day's booked utilization and inspect its inclusion rules; finance can trace cash receipts and receivables to authorized source records. Late payment/refund or booking correction updates its contribution once. Website conversion events cannot inflate sales. This is ordinary business reporting, not an accounting engine or a large-scale observability product.

Frontend acceptance journeys:

- A manager selects one day/location, reproduces booked utilization from its numerator, denominator and exclusions, then opens only authorized source rows. A closed range with no saleable denominator shows not-applicable.
- Finance traces cash receipts/refunds and receivables to source revisions. A lagging or unavailable source yields labeled incomplete output/export rather than zero, and a later correction updates its contribution once without mutating invoices.

## Composition and Ownership

Shared reporting package, initially surfaced in the workspace and finance interfaces. A separate cross-app dashboard deployment is optional. CanRent may retain a basic local availability/occupancy view; it must use the same definitions when presenting portfolio measures.
