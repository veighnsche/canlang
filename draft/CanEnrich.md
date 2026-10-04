# CanEnrich

## Purpose and adoption goal

Give a customer-operations department a small reviewed company-data service: connect an existing customer to its known UK legal-company number, compare registry evidence, and retain accepted legal name, registered office and registry status with provenance. It replaces this particular enrichment workflow, not a customer directory, billing system or universal prospecting database. No AI inference is needed to invent public facts; the provider supplies evidence and a person accepts it.

## Users, permissions and ownership

Researchers link company numbers, enable/disable links, request results, authorize fallback and stop a review. Reviewers accept individual facts with a reason and the expected previous acceptance. Both roles can inspect team evidence. Being an enrichment researcher does not grant the separate customer directory's read permissions; composed deployments assign those roles deliberately, and unresolved/hidden customer labels stay protected. Every browser and MCP operation uses the same canonical checks.

The source owns Company, Lookup, Run and immutable AcceptedFact history. It imports canonical Customer identity, never a copy of Customer/BillingProfile. A company link freezes its customer and number. At most one link is enabled per customer; a wrong or changed legal identity is corrected by disabling the old link and creating a new number, preserving the old evidence. The `(customer,number)` pair remains unique, so re-enabling a previous identity reuses its history rather than evading that link's request accounting. Inputs accept eight characters; the bound UK provider validates its actual legal-number format/existence and never silently converts it to a different organization. A rejected number can be retired and corrected through this same flow.

## Data and provenance

The exported Fact value contains the exact provider value, evidence URL, optional source-observation time and safe detail. Reports identify the requested number and configured provider slot and distinguish a completed lookup from a partial result. Missing facts remain null; neither absence nor a disputed address is converted to an authoritative empty value. The lookup's own creation time and protected receipt retain when this app requested evidence; a provider's older observation date stays visible.

One immutable Lookup associates a typed provider receipt with its company and source. Runs reference those lookups, including a reused successful lookup, rather than copying transport states or results. A newly selected Run supersedes earlier reviews but retains their evidence. AcceptedFact stores the selected Fact, exact Lookup, field, reviewer, reason and prior accepted decision. Monotone per-field ordinal plus uniqueness makes `current(company,field)` deterministic even when several decisions share a timestamp. Subsequent provider changes never edit an earlier acceptance.

## Workflow and limits

1. Researcher links a company and starts a review. A successful primary lookup created in the last seven days is reused unless `refresh=true` explicitly requests another. Reuse preserves the original provider observation time; seven days is a company cache policy, not a claim of provider freshness.
2. A fresh lookup requires fewer than four recorded requests for this link on the current UTC date. Each new request creates one Lookup in the same transaction as its send. Atomic admission fences concurrent calls. This is a logical-request ceiling, not a monetary quote or an unlimited provider retry allowance.
3. `fallback=true` consents to a secondary lookup only after the selected primary returns a definite complete result missing at least one of the three fields. A recent successful secondary result is reused first. No secondary request starts after stop, link disable, replacement by another review, requester role removal or customer deactivation. Insufficient remaining capacity leaves the missing fallback visible and permits a later explicit attempt; it does not fail the already completed primary result.
4. Pending/failed/unknown primary work never automatically incurs secondary cost. A researcher can explicitly request the second source after a terminal transport state, including unknown, accepting the possibility that the first was charged. Each Run has only one secondary lookup. A later fresh review can request new evidence within the same cap. Stopping does not cancel, refund or erase an accepted remote request.
5. A reviewer selects one successful primary/secondary lookup and one field. The app selects the exact fact from that typed report; callers cannot substitute its text/provenance. The linked company number/provider must match. Missing fields reject. The expected prior acceptance must be the current one; an unchanged full Fact rejects. A differing source may be chosen with an explicit reason, preserving disagreement and prior evidence.
6. Accepted facts remain supplemental. Registry name does not replace a customer's chosen display name. Registry office does not replace a billing address. Other apps may import the exported values/current derive under normal grants, then use their own reviewed operations if they need a business change.

A delayed result remains on its original Lookup. Only a completion still referenced by the selected Run can trigger its consented continuation. Review admission checks current selection and authority; old/stopped Runs cannot accept new facts. Existing accepted history remains attributed after personnel changes.

## Shared mechanics versus company policy

Typed capability sends, retained delivery results, retries/unknown evidence, admission versions, transaction fences, schema-derived forms, audit history and safe links are shared contracts. No fetch loop, provider JSON decoder, credential field, copied transport state machine or handwritten UI is in this source.

Seven-day reuse, four requests, primary/secondary order, missing-field triggers, explicit extra-cost consent and per-field human acceptance are this department's policy. An ordinary Fact contract shares provenance across the three fields. The current draft intentionally does not introduce a universal enrichment DSL bundling every cache/merge/provider policy. JEV favored exploring that larger abstraction, with low-to-moderate confidence; the exact comparison and current limited decision are recorded in the design note. Future repeated business-independent coordination across a second concrete enrichment workflow would justify factoring more, rather than declaring this witness proof that no further primitive could help.

## Provider contract

`SourcesV1.lookup(number,provider)->Report` is one interface with two fixed configured slots: Companies House and OpenCorporates. The binding pins credentials, permitted hosts, API/version, jurisdiction (`gb`) and identity normalization. It validates the report's number/provider against the request before successful completion; safe source URLs are evidence links, never an instruction to fetch an arbitrary destination. Response sizes are bounded by the declared Fact/Report schemas. Malformed replies, throttling, access denial, unsupported identifiers and ambiguous transport failures remain failures, not invented successful empty results. Provider retry policy must expose uncertainty and cannot hide unbounded paid attempts behind one logical lookup.

A completed lookup may legitimately have absent facts; a partial response has `complete=false`. Address-dispute/undeliverable warnings and partial-data flags remain in fact/report detail, and an unsafe address is omitted. Provider query completeness is distinct from proving a registry claim true. Billing/account terms and allowed usage must be configured for each deployment; commercial enrichment is not assumed free.

Verified primary references: [Companies House company profile](https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/resources/companyprofile?v=latest), [Companies House API reference](https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/reference), and [OpenCorporates API reference](https://api.opencorporates.com/documentation/API-Reference). No real customer lookup was performed.

## Frontend and personal settings

The inherited application shell supplies sidebar/navigation, account menu and settings. The enrichment page has a company-link form, enabled/disabled filter, enable control and typed research form. Its drawer shows the link's daily request count, runs and consent flags, primary/secondary statuses and full typed reports, explicit fallback/stop controls, fact acceptance form, accepted history and provider receipt/error history. Source URLs/timestamps/disagreement remain inspectable before review. Current accepted fact is the highest ordinal for its field; the history table exposes those ordinals.

The page polls stored evidence every five seconds; it does not query either provider. Shared daisyUI components and HTMX preserve form values and current authority. No raw HTML, `h`, Preact or client business store appears. English/Dutch wording stays inline. The enabled preference filters Company; shared account/language/appearance/security settings are inherited.

## Behavior examples and verification

Nineteen table rows cover cache reuse, explicit refresh, role/disabled rejection, consented missing-data fallback, stopped/nonconsented/unknown-primary suppression, secondary-cache reuse, explicit unknown-cost consent, exact accepted evidence, stale prior decisions, provider disagreement and missing fact rejection. Two connected sequences show the four-request limit and stop preventing a later fact acceptance. Fixtures provide typed isolated receipts and source evidence; they make no network request or claim that providers ran.

The JavaScript is a handwritten desired target with proposed library imports. Syntax/static correspondence and the supported subset of the existing parser are checked separately; successful parsing or `node --check` does not execute business rules, providers or examples. Associated deliveries, polling and sequence syntax are explicitly excluded from the old parser projection. The focused review record is in `design/complex-apps/enrich.md`.

## Scope boundaries

This draft excludes unknown-company discovery, person/contact enrichment, probabilistic identity merging, bulk CSV enrichment, automatic deletion/field clearing, billing writes and arbitrary dynamic provider chains. Those are different company policies/capabilities, not hidden promises. Existing source evidence may be old or disputed, provider access can fail, and an uncertain request may remain uncertain; all stay visible and bounded rather than being treated as successful facts.
