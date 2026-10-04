# CanEnrich: reviewed company facts from bounded provider lookups

Root-owned design for the complex-app goal. The complete triplet is written and independently reviewed. No provider/runtime is implemented. No Muse writer owns these paths.

## Concrete company outcome

A department links a known UK legal company number to an existing canonical CRM Customer and fills legal-name, registered-office and registry-status facts. It reuses earlier successful lookup evidence, consults a second configured provider for missing facts, compares disagreement, and applies individually reviewed claims with per-field provenance. A registry address never silently becomes a billing address; a registry name never overwrites Customer.name. CanEnrich owns the supplementary facts and exposes their owner interface for composition.

## Verified primary sources

- [Companies House companyProfile](https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/resources/companyprofile?v=latest) exposes company number/name/status and optional registered-office data, including disputed/undeliverable address and partial-data indicators. The [reference](https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/reference) identifies GET /company/{companyNumber}. Preserve missing/disputed data rather than inventing a verified address.
- [OpenCorporates API reference](https://api.opencorporates.com/documentation/API-Reference) describes company lookups by jurisdiction and number, name/status/address fields, retrieval/source attribution and account-dependent API usage limits. API access and terms must be configured for the company; this is not a claim that commercial use is free. Provider freshness and completeness vary.

The first direct open of an obsolete Companies House documentation URL failed; the current official specification above was then found and checked. No enrichment requests or real company/customer data were sent to either provider.

## App versus shared mechanics

The ordinary typed capability owns transport, credentials, destination pinning, provider response normalization, safe diagnostics and exact source identity verification. One interface with a closed registry/aggregator source selector permits one completion path; its configured slots identify the actual provider and permissions. It is an app-owned versioned interface usable by library adapters, not compiler knowledge of every external API.

The app owns the verified customer/company-number link; requested business fields; seven-day retained-result reuse versus explicit paid refresh; at most four logical lookups per company/UTC day; automatic fallback only after a complete definitive primary response lacks requested facts; explicit consent after ambiguous/failed primary work; human choice among disagreement; per-field accepted history and current-authority application. Failed requests never replace successful cached evidence. This cap bounds logical requests, not a promised monetary price.

Three fact fields all carry the same ordinary typed `Fact {value,source,observed?,detail?}` contract and refer to one immutable lookup. No new generic provenance primitive is justified merely to wrap text three times. The general primitive candidates exposed elsewhere (judgment, associated progress, typed invocation and authorized retrieval) remain open to adoption where they remove actual repeated mechanics.

## Required witness

CompanyFacts owns customer/registry identity and active run selection. Lookup retains typed protected delivery; Run references a primary and optional fallback lookup, including reused successes; it does not copy their transport state machine. An AcceptedFact is an immutable company decision bound to one exact field/result, reason, reviewer and prior accepted value. Concurrent application checks the expected prior decision; missing versus overwrite is explicit. The provider result preserves unknown/incomplete/disputed evidence, so an empty result cannot be mistaken for a verified absence.

UI must show source timestamps, provider/source URL, request outcomes, whether reuse avoided another lookup, disagreements and individual accept/replace controls. Company-defined values remain editable only through reviewed owner operations. Inline examples must include cache reuse, per-day cap, partial primary/fallback, no automatic cost after unknown, late completion after stop, identity mismatch, disagreement review, stale selection, permission loss and acceptance retaining provenance.

## Consultation and retained uncertainty

Three equivalent independently worded comparisons are saved in [the Enrich consultation](../jev/complex-enrich-20261004). Each compared the same complete workflow using ordinary values/receipts/records versus a reusable enrichment declaration. JEV favored the broader declaration with probabilities .57/.63/.75 and confidences .14/.26/.50; the ordinary alternative retained .43/.37/.25. That is a consistent but weak-to-moderate preference, not a mandate or measured authoring benefit.

We investigated the actual ordinary witness: it has four domain models and two bounded trusted handlers. Lookup is immutable paid-request evidence used by the company's daily accounting and source review; Run is a selected consent/review decision; AcceptedFact is a company acceptance with prior decision; Company owns legal-identity linkage. Transport status/results are already shared associated receipts. Reuse is one query over existing evidence, rather than an implemented cache/invalidation subsystem. A universal enrichment declaration would currently combine company policies (reuse window, billing consent, missing-field trigger, acceptance and downstream ownership) rather than remove another demonstrated transport replica. Retain this bounded ordinary witness for now; do not present it as proof that a broader reusable declaration can never help. The new primitives found in the other apps remain accepted independently.

## Actual draft and review boundary

`CanEnrich.can/.mjs/.md` now contain the complete reviewed workflow, two provider slots, ordinal fact history, enabled identity replacement, explicit cost limits/consent, shared UI and 19 table cases plus two connected sequences. Target metadata uses the canonical registry, protected receipt locators and expression-order descriptor. A stopped result is re-queried before the subsequent assertion/call so the example tests the business guard rather than an accidental stale-reference error.

Independent reviewer checked the actual source/target body ordering and metadata, finding the captured sequence reference above, now corrected. Final syntax/projection evidence is recorded below after checks; none executes BDD or provider behavior.

The final independent correspondence pass checked the Customer owner interface, current-selection/role guards, immutable receipt identities, per-field prior decisions, isolated receipt setup and both connected sequences. Repairs export Fact consistently with the requirements, bind the enabled edit to canonical `enrich.Company.update`, retain the `Company` CRUD admission reference in metadata, use field-style result descriptors throughout, and return the shared `{fixtures,examples}` factory shape. The existing deferred page builder is retained. No provider behavior, transport state model or source business rule was added. Static checks cover descriptor references and source/target inventories; they do not execute the nineteen table cases, two sequences, adapters, renderer or authority fences.

[Final static evidence](../jev/complex-enrich-20261004/final-verification.json) records passing JavaScript syntax, twenty-seven resolved handler/rule references, matching source/target inventories and a passing supported-syntax projection. The unchanged prototype still rejects the full source at the first `delivery(...)` type. The shared bounded [descriptor inspection](../jev/complex-workbench-20261004/final-descriptor-review.cjs) can be rerun without executing business operations or BDD.
