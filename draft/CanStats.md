# CanStats requirements

Inherits [canlang requirements](../REQUIREMENTS.md) and [workspace operator context](WORKSPACE_OPERATOR.md), with [portfolio composition](PORTFOLIO.md). Companion draft: [CanStats.can](CanStats.can).

## Purpose and Adoption Goal

Help workspace marketing teams understand traffic and tracked inquiries on location, workspace, and event pages. Adoption depends on knowing which pages and acquisition sources lead to observed customer interest.

## Users and Permissions

Authorized analysts view scoped reports. Developers provision sites and maintain goals, reporting defaults, tracker configuration, credentials, quotas and technical retention directly in the authoritative database/configuration outside the product UI. Collection requests identify their site through its tracker key; report access requires team authentication.

## Data and Ownership

Site stores team, domain, reporting timezone, goals, and tracker configuration. Accepted events have a stable event ID, site, event name, event/receipt times, and normalized dimensions. Keep first-party pseudonymous visitor/session activity in D1 for a rolling 30-day reporting window; do not put those identifiers or personal contact data into Analytics Engine.

Allowlisted dimensions include public location ID, workspace type, page path, and sanitized campaign source/medium. Goals name explicitly instrumented tour_request, quote_request, and booking_complete events; they do not contain customer contact or payment data.

## Workflows and Business Rules

Define visitors as distinct available tracker identifiers, not guaranteed unique humans. Count visitors active within the selected range and sessions whose recorded start falls inside it; sessions expire after 30 minutes of inactivity. Count each accepted event once; a conversion is an event whose name is in the site's goal list. Date ranges use local reporting days with an exclusive end. Live visitors use validated activity time within five minutes, not arrival of an old queued event. Events without identifiers still count, but identity-metric coverage is shown.

## Pages and Interactions

Use the staged [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration). Website traffic /traffic is the analyst-only sidebar destination. Configured sites appear within the page; ingestion/tracker URLs are machine endpoints, not navigation or settings destinations. Add no site-provisioning or developer administration console.

| Page or logical destination | DaisyUI presentation and content | Owning actions and conditions |
| --- | --- | --- |
| Site/range summary /traffic | Configured Site List; date Fieldset defaulting to 30 reporting days, timezone label, existing-goal Select and Stat values for accepted events, observed goals, visitors/sessions/live activity. | summary reads authorized configured sites with exclusive-end local dates; selection cannot modify goals or tracker configuration. |
| Acquisition and content breakdowns | Location/page/source/medium/workspace Tables with sample/estimate Badge, denominator and tracked-identity coverage. | Scoped report reads distinguish exact D1 counts from weighted sampled breakdowns; ranges cannot simply sum distinct visitors. |
| Observed conversion goals | Goal Table with accepted-event count, rate denominator and explicit tracker-observed caption. | Existing-goal selection only; tour/quote/booking events are neither trusted payment evidence nor confirmed sales. |
| Ingestion health and event inspection | Health Table/Alert for accepted/dropped events, last processing and lag; bounded accepted-event Table with allowlisted dimensions. | Authorized reads; no keys or personal identifiers/contact data in reports/export and no technical configuration writes. |

Narrow layouts retain labeled Stat values and use Cards for dimensions/health while preserving estimate, coverage and freshness labels. Loading, zero supported data, absent identity coverage, unsupported result and unavailable source remain distinguishable. Keep the selected range when a read fails and show stale prior results explicitly; exclude old queued events from current live activity. Tracking drops never obstruct the measured site's navigation/submission. The existing shared authorized CSV export uses current filters and conveys exact versus estimated coverage without adding identity data or a separate app export operation.

## Personal Configuration

Inherit [shared shell and personal configuration](../REQUIREMENTS.md#standard-shell-and-personal-configuration) for persisted, validated language/appearance and account controls. Optional saved site, report tab, range and existing-goal filters are personal presentation choices, revalidated against current access. They do not alter configured reporting timezone, instrumentation, consent, quotas, keys, retention or source goals. Site/tracker provisioning and reporting defaults remain developer maintenance outside the product UI.

## Interfaces and Integrations

Use D1 for configuration and exact accepted-event/visitor/session summaries, Queues for processing, and Analytics Engine for sampled dimension breakdowns indexed by site. Apply sample weights to sampled totals. Analytics Engine [uses weighted sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/) and [retains data for three months](https://developers.cloudflare.com/analytics/analytics-engine/limits/); it cannot be treated as an exact session log. The tracker is first-party, supports the host site's tracking-enable/consent signal, and strips sensitive URL parameters.

Site/tracker/goal provisioning and technical settings are developer-maintained database/configuration records, not end-user forms or MCP business tools. The report UI can select existing goals/ranges and inspect ingestion status without acquiring configuration write access.

## Background Actions

Deduplicate events before updating D1 summaries, process bounded batches, and expire reporting identity state after 30 days. Validate/clamp unreasonable client timestamps and report ingestion lag. Tracker routes enforce site quotas; public site keys provide no report/admin access.

## Error Handling

Reject oversized or malformed events and unknown sites. Do not claim origin checks make public browser events trustworthy. Show drops, processing delay, and unavailable reports; failed tracking never blocks navigation or submissions on the measured website.

## Scope and Completion

Complete when duplicate events do not inflate counts, two ranges do not incorrectly add distinct visitors, session/goal rules are reproducible, and estimates/freshness are visible. This is an initial 30-day web analytics product.

Marketing can compare tracked location-page interest and observed booking goals over a reproducible reporting period, without presenting a browser event as confirmed sales or invoiced revenue.

Authoritative utilization, paid cash, receivables, paid renewals and facilities backlog belong to CanReport. This app's goal rates are explicitly tracker-observed and are never substitutes for the business ledger.

Frontend acceptance journeys:

- An analyst compares location-page interest for two reproducible ranges and reads identity coverage plus exact/estimated labels; duplicate events count once and visitor totals are not naively added across ranges.
- A delayed queue produces a lag Alert and does not inflate five-minute live activity. Observed booking goals remain visibly separate from CanReport cash/booking outcomes, including when a report is unavailable.

## Composition and Ownership

Recommended placement: Digital website analytics module. Own tracker configuration and observed website event metrics. CanReport owns authoritative booking, cash receipt and receivable measures; website goals cannot manufacture those outcomes. See [portfolio composition and ownership](PORTFOLIO.md). Focused example requirements remain valid; composing packages does not require a new source file or an independent deployment per package.

## Tracker, identity and health contract

Developer maintenance uses canonical owner admission, not raw database writes that bypass the revision fence. The installed tracker binding resolves Site from its configured public key and accepted origin/site namespace. A payload cannot appoint another site, quota or report viewer. Public keys and origin checks never authenticate the truth of browser activity.

Version 1 accepts a closed event schema up to 64 KiB UTF-8. Event IDs are SDK-generated UUIDv7 values whose embedded time is validated against the admitted occurrence window; retained technical replay digests bind identity to normalized content. Duplicate delivery cannot become new work after the 30-day content lifetime, and changing content under a still-known identity fails. Unknown/malformed sites, over-quota events and invalid timestamps are rejected explicitly. The UTC-day quota counts unique accepted events; identity, quota and durable work intent share owner admission. A receipt acknowledges durable work, not successful Analytics Engine delivery.

The first-party tracker follows the host's enable/consent signal before collection or identifier storage. With collection disabled it sends nothing and clears its local visitor/session identifiers. Where collection is enabled but identifiers are disabled, the event carries null visitor/session/start and still contributes to event counts; the report displays reduced identifier coverage. With identifiers enabled, random site-specific visitor/session values are used without fingerprinting or cross-site identity. A session starts at first activity and a new session starts after at least 30 minutes without activity; its recorded start is stable across the session. Withdrawal resets that identity. Server validation requires session/start together, a visitor for an identified session, and start no later than occurrence. These are observed tracker sessions, not authenticated people or proof of continuous human presence.

Normalize URLs to site-relative public paths. Drop user-info, fragments and all query parameters before persistence; collect sanitized source/medium separately from the supported campaign fields. Never send contact fields, form values, cookies, payment data or member documents. Tracking is configured only on the site's intended public pages; raw private-resource paths are excluded at the tracker boundary. Dimensions are bounded strings from the configured site mapping, not arbitrary JSON. SDK queues are bounded and failures never obstruct host navigation or submissions. Runtime/SDK implementation remains absent.

The verified Tracker.health source supplies cumulative rejected/dropped totals, a persistent monotonic revision, observation time and processing availability. It cannot decrease totals or change values under an identical revision. Accepted counts and last_processed advance only when the owner actually creates a new AcceptedEvent. A missing health record or health older than five minutes yields unavailable summary values, not a fabricated zero. Empty captured ranges are zero only with current available evidence. Future-within-tolerance events do not enter current live or range counts before their occurrence time. Local-day reports reject starts outside the fully retained window; the current day is an as-of-generated snapshot rather than a completed future day.

## Weighted breakdown contract

The existing `analytics WebDimensions` declaration remains the sole write path. It sends only site, event name, normalized path/location/source/medium/workspace, occurrence time, a non-identifying presence flag and numeric event value. Visitor and session IDs never enter Analytics Engine. The installed binding maps this declared schema to its pinned dataset fields and site index; the read adapter uses that same mapping, not a second authored schema/configuration file.

DimensionsV1.read is an explicit typed, asynchronous adapter contract over the existing Analytics Engine SQL API. It accepts one authorized site, UTC range, one closed dimension and a frozen copy of the current configured goal names, plus an optional selected goal. That copied goal set is retained on the request and must match the response, so later goal edits cannot relabel a queued report. There is no arbitrary SQL, field name, dataset or account input. The adapter rechecks the delegated analyst and site grant, filters its pinned site index and stored occurrence timestamp through the generated instant, and uses one query snapshot. Unknown dimensions/goals or unavailable sources fail instead of becoming empty rows.

Each weighted event count is the sum of that row's `_sample_interval`; weighted goals and identified-event counts apply their predicates to those same weights. A selected goal changes the goal numerator, not the overall event denominator. Null dimension values form one explicit unknown bucket. Totals include all qualifying groups; up to 200 rows are returned in descending event-count/key order, with complete=false if groups were omitted. Duplicate group keys, contradictory counts/ranges or mismatched site/dimension/goal are invalid results. Complete describes group coverage, not proof that every browser event reached telemetry. Sampling, ingestion drops and uncertain telemetry delivery remain separate from exact accepted D1 counts. Distinct visitors/sessions are not calculated by summing sampled groups.

The result reports its sampling flag, coverage, generated time and whole-query denominators. Weighted event/goal/identified values remain visible together so their ratios have explicit denominators; no unsupported precision or confidence interval is invented. The page shows pending, available, partial, failed and unknown separately, and its bounded polling rereads completed results without starting another provider query. Each explicit request supersedes the caller's previous result; other analysts cannot read it, stale completions cannot overwrite the current report, and the projection expires after one day. Existing authorized table export preserves these result values and captions without identifier columns.

Cloudflare documents row-specific weighting and `sum(_sample_interval)` for counts in its [sampling reference](https://developers.cloudflare.com/analytics/analytics-engine/sampling/). Its [SQL reference](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/) is the adapter's query surface. These references support the provider contract; no query adapter or live report has been executed here.
