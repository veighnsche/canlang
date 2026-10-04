# CanDiscover — bounded opportunity monitoring

Draft owner: fixture_contract. Coordinator released the app triplet, and H007 writer release is acknowledged. This app is a reviewed opportunity monitor, not a general autonomous browser, proprietary contact database or procurement submission agent.

## Verified source and ownership facts

The two initial adapters target published **TED procurement notices** and **Grants.gov funding opportunities**. TED exposes anonymous POST `/v3/notices/search`; its documented iteration mode returns continuation tokens, with at most250 notices and10,000 fields per page. App policy will choose a smaller20-document bound. [TED API](https://docs.ted.europa.eu/api/latest/search.html), [iteration and limits](https://docs.ted.europa.eu/ODS/latest/reuse/search-api.html).

Grants.gov documents anonymous POST `https://api.grants.gov/v1/api/search2`, keyword/status filters and result rows containing opportunity ID, number, title and close-date text. Its response exposes startRecordNum/startRecord, rows and hitCount. The displayed request example does not fully specify offset or snapshot consistency guarantees; adapter qualification must verify accepted paging inputs before declaring exhaustive traversal. Missing/blank close dates stay unknown. [Official search2 contract](https://www.grants.gov/api/common/search2). The separate anonymous fetchOpportunity endpoint documents opportunity ID, revision, synopsis and attachment metadata; search hits alone are not complete cited evidence. Its source text can be normalized and retained by the bound adapter, while attachments require the shared file finalization contract. [Official detail endpoint](https://www.grants.gov/api/common/fetchopportunity). No live provider request or undocumented parameter has been tested. A moving offset result set cannot be claimed to be a frozen snapshot.

Current CanCRM exports `Deal`, `salesperson`, `ResearchLead` and `promote_research(source:text,input:ResearchLead)->Deal`. Discover calls that owner operation under the current caller. CRM freezes source/input/deal, returns an identical replay, rejects changed input under one source and retains current work/customer/contact/currency checks. Discover does not write foreign Deal records or fabricate contact identities.

## Orchestration comparison and advice

Three independently rewritten requests and complete replies are saved under [complex-discover evidence](../jev/complex-discover-20261004). All are new normal-approved calls; no previously rejected payload was retried or rerouted.

| Request | Explicit page state | New resumable syntax | Delegated research job | Selected / confidence |
| --- | ---: | ---: | ---: | --- |
|1|.50|.05|.45|explicit /.25|
|2|.77|.19|.04|explicit /.66|
|3|.18|.06|.76|delegated /.64|

There is real disagreement, not three approvals. Delegating paging can substantially shorten the app, but a complete delegated contract still needs per-source cursor durability, retained input/result revisions, budget reservations, cancellation, late-result quarantine and no permission to promote. That is a viable reusable service boundary if adopted centrally. For this bounded draft, use ordinary per-source page state and typed requests; do not invent new suspension syntax. Source continuation is business-visible progress, while transport receipt state remains the existing associated delivery rather than a copied status mirror. The choice is provisional against any smaller shared observable-run contract the coordinator adopts. No code/token/performance comparison or provider success is claimed.

## Applied draft and precise limits

The actual artifacts are [requirements](../../draft/CanDiscover.md), [source](../../draft/CanDiscover.can), and [desired JavaScript](../../draft/CanDiscover.mjs). Requirements describe the accepted business boundaries; the source owns executable declarations, with no second service manifest in this note. Existing capabilities, typed deliveries, keyed schedules, locked values, ordinary owner calls and inline examples express the workflow. No shared language/runtime implementation was added.

The eight models are Plan, Run, SourcePass, PageAttempt, Opportunity, Evidence, Conflict and Review. Two app-owned capabilities provide bounded pages and typed final extraction. Per-source continuation and coverage are authored business state; delivery status/results/errors stay in associated receipts. Opportunity's latest evidence derives from a unique immutable ordinal, avoiding both a mutable duplicated reference and cyclic fixture graphs. Conflicting same-revision source bytes are retained separately and block promotion until a documented review. Pure analysis fit/confidence are advisory estimates; they do not claim the shared probabilistic judgment contract.

Each run freezes two queries/window/criteria and exact page/document/analysis/output-token limits. Page sends and analysis sends recheck current Plan.current identity, active plan, non-stopped run and current initiating researcher/work eligibility at delayed dispatch. A superseded run cannot restart business progress through a late reply. Pause stops current continuation and recurrence; take_over explicitly adopts future responsibility as the current caller. Source attention permits a fresh reserved read retry. Unknown prior work may still consume provider resources; limits are per run, with no monetary/global-outstanding guarantee or claimed remote cancellation. Manual review is recovery from unavailable model analysis.

Source completeness requires exhausted traversals, snapshot mode and one nonnull consistent instant within each source. Different sources may have different instants. The normalized interface cannot manufacture provider guarantees: Grants.gov continuation/snapshot behavior remains adapter-qualification work. A short page, missing source or budget boundary is never asserted to mean no opportunities. Original bodies are bounded, retained plain text; external attachments are not silently claimed to be retained evidence. The deployment-bound adapter must reject silent truncation, mismatched cursor/query/window and malformed output. No live provider request has run.

## Focused verification

- `node --check draft/CanDiscover.mjs` passes.
- Static declaration inspection finds 8 models, 7 contracts, 14 user operations including enabled Plan CRUD, 5 trusted handlers and 10 fixture recipes. Every user operation registry entry resolves to a desired handler; source/target stored field-name sets and user-operation identities agree.
- 10 isolated tables contain 20 rows. Two connected user sequences exercise start/pause/take-over/resume/restart and actual review/CRM promotion/identical replay/changed-input denial. Provider evidence in the second sequence is explicitly seeded; it does not prove acquisition. Callback rows provision typed requests and final consistent receipt envelopes, including unknown results and conflicting retained source bytes.
- The initial parser rejects associated `delivery(...)` types. A temporary projection replacing those types with text and omitting only sequence bodies parses successfully. This is supported-syntax inspection, not a full grammar parse, typecheck or test execution.
- No example runner, adapter, compiler, library, UI server, MCP server or distributed lifecycle was executed. Runtime checks still need to establish admission fencing, concurrent ordinal allocation, provider result validation, source continuation guarantees, claim rejection and current authority revocation. Desired callbacks and assertions are contracts, not empirical business-test results.

The saved three-call disagreement remains unchanged. The delegated research-job alternative is viable if a shared complete contract delivers the same observable coverage, evidence, cursor, budget and recovery outcomes with lower whole-design cost. This app does not invent an incomplete generic job API merely to reduce its line count.

Coordinator review repair: removed an unintended PageAttempt.create admission callback that referenced the not-yet-created attempt; its source has no such guard. The current-attempt dispatch predicate remains on the send, where staged association changes exist at dispatch. Consolidated target handlers/rule maps into the single canApp factory, without a global handlers registry/spread. A fixture was renamed reviewed to avoid colliding with scenario review; stale-version examples use positive version 2 against fixture version 1. Node syntax was rerun after these bounded repairs. These corrections illustrate why declaration counts alone are not behavioral verification.

## Independent review corrections

The independent review normalized model-derived metadata/registry wiring and source UI operation bindings. It also found asymmetric URL-collision admission: a newly colliding identity was blocked but the earlier identity could still proceed. Both now use the current `needs_identity_review` derive before review/promotion, and a real duplicate-resolution sequence covers the correction. The final source has 11 fixtures and three sequences. Expression ordering uses the canonical key/direction descriptor. JavaScript syntax and descriptor references passed; these are not executed BDD evidence.
