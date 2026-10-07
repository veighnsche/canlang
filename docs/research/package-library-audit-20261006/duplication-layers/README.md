# Duplicated mechanisms and unnecessary layers

Planning audit, 2026-10-07. Frozen source:
`4659b9477173e9ff423d2b4d8f1d1a19c8c2d007`. **Implementation remains deferred.**
Every record has `execution_authorized=false`. This audit changes no package,
dependency, acceptance status, backend selection, public API or runtime resource.

There are **31 conditional change candidates**: 17 consolidations, 11 simplifications
and three deletions. Another **18 records explain boundaries to retain**. These are
49 review records, not 49 implementation tasks or independently counted algorithms.
`DR08` aliases `DC-01` and adds no obligation. See the [complete candidate list](candidate-list.md)
and [source/caller/gate records](candidates.jsonl).

The strongest reductions come from sharing existing private mechanics within their
owners. Several library replacements already removed the old mechanism: there is
one shared library CSV grammar, native-backed identity comparison and platform signal
fan-in. More wrappers around those replacements would add maintenance without helping
their callers. Other growth comes from retained donor/oracle implementations and
unadopted preparation paths; their actual replacement and retirement gates remain open.

## First candidates to assess for a future simplification packet

All entries below are proposals. Source identity confirms duplication; it does not
qualify a changed implementation. Prefer a private helper with the same caller
arguments over a new general framework.

| IDs | Candidate and actual caller evidence | Expected maintenance benefit | Required boundary |
| --- | --- | --- | --- |
| DC-01 | CSV review uses `canonicalJson` at `http/csv.ts:254,273`; export projection/digest uses its exact copy at `http/export.ts:156,429`. | One interfaces-owned recursive serializer. | Keep exact bytes, getter order, odd-value failures and digest namespaces. Media and replay serializers are related, not equivalent. |
| DR01 | D1 and Durable Object storage invoke copied SQL predicate/order and stored-row conversion helpers from their real store methods. | One private SQLite mechanics owner. | Preserve bound argument order, conversion timing and errors; keep asynchronous D1 batch and synchronous DO transactions separate. |
| DR03 | Ten UI renderer modules call identical `pickAppearance` bodies; two also duplicate `idAttr`. | A single appearance projection and small attribute leaf. | Keep repeated getter reads, order, escaping, classes and renderer ownership; no theme framework. |
| DR04, DR05 | Forms/controls copy draft-value leaves; export/print and CSV preview/confirm call identical safe error-digest bodies. | Shared browser-safe leaves without merging layouts or handlers. | Preserve plus signs/leading zeros, field errors, getters and fallback throws. Retain exported digest names and avoid dragging full CSV/browser modules into the helper. |
| DC-02 | Playback Worker checks scripts; services tests/differential tests call the mirrored scenario parser. | One portable admission owner instead of two evolving rule sets. | Current services media conversion uses `Buffer`; preserve Worker support, error identity and dependency/distribution ownership. Its harness imports are type-only. |
| DD-001 | Real TS deploy calls `buildDeployBundle`; protocol tests also call explicit adapter phases whose Bun/catalog bodies duplicate existing bundle exports. | Reuse those exports and remove three copied bodies. | Keep phase ordering, flags, marker/errors, cleanup and installed resolution. Selected copied ranges span 123 physical lines, not a forecast of saved production LOC. Preparation remains held. |
| DR11, DR12 | Schema/wire cores append violations through identical helpers; date constructors/parsers/month arithmetic copy Gregorian leaves. | One append implementation and one cycle-free calendar leaf. | Preserve synchronous error order, frozen paths and absent fields. Calendar leaf imports neither `kinds` nor `temporal`; keep caller-owned range/clamp policy. |
| DR06, DR07 | Prepared HTTP/MCP builders duplicate binding projections; CSV/export/upload routes duplicate body admission; MCP/upload routes duplicate Bearer extraction. | Reuse exact small projections/extractors. | HTTP/MCP authority and handle/default rules remain separate. Body error identity/order and literal-space Bearer grammar stay unchanged. |
| DV03, DD-003, DD-004 | Registered Rust Work decisions repeat code-unit helpers; held preparation artifact/input modules repeat ASCII accessors and UTF16 quoting. | Reduce copied mechanism drift inside each owner. | Whole Work carrier unification remains HOLD: value variants, identity, cloning and error profiles differ. Native preparation remains HUMAN HOLD. |

These helpers usually leave call signatures unchanged: the benefit is fewer bodies
to maintain, rather than fewer arguments at every call. Where a new abstraction adds
profile switches, conversions or generic plumbing, its benefit remains unproved.

## Other conditional candidates

| IDs | Proposal | Gate or limit |
| --- | --- | --- |
| DV01, DV02 | Use existing `ryu-js::Buffer::format` for its own special cases; replace private numeric forwarding functions with explicit channel imports. | Preserve String versus JSON channels. Removing guards while still using `format_finite` is incorrect; private alias removal offers only modest navigation benefit. |
| DV04 | Share a qualified retry predicate under leaf-owned policy/errors. | First failure, defaults, contextual prefixes and distinct public types must match; do not add an adapter framework. |
| DV05, DD-002 | Consider public wire aliases and the deploy forwarding seam. | Keep import paths, public observations and any declared seam. Removing a frame does not simplify an entire workflow. |
| DV08 | Remove the WeakSet/write for factory lineage if its existing test assertion and future gate are explicitly retired. | Only the query has test-only observed callers. Weak references are not a demonstrated retained-state leak. Preserve separate owner/provenance registries. |
| DV09, DC-03, DC-04 | Separate Work/Files doubles and Services mail harness from runtime port modules. | They have public/source export obligations. A compatible file move may improve readability while retaining all emitted bytes; do not claim shipping savings without closure evidence. |
| DC-06 | Reuse factory-produced frozen HTTP shape arrays instead of copying each CSV row. | Readonly compatibility is already verified. Public forged/proxy/custom-iterator plans need evaluation/error-order qualification; metadata removal is a different decision. |
| DD-007, DD-012 | Consider job-local import record reuse and the small keyed rejected-promise cache primitive. | Measure benefit before adding layers; preserve independent policy passes, source identity, two caches, synchronous throws, promise identity and initialization order. |
| DD-009 | Remove obsolete state test-loader vendor exclusions after fresh/stale archive qualification. | Standard builds already clean outputs; direct emission and installed archives remain gates. Keep the live observer loader and Node-only exclusions. |
| DD-010 | Resolve the unadopted prepared MCP layer: qualify adoption or choose supported relocation/retirement. | Its observed callers are tests, but that alone does not cancel programme obligations. Package emission is observed; staging that prototype into the Worker is not proved. |
| DD-015 | Remove two publication-key alternatives dominated by earlier/broader predicates. | Keep current first-error order and `C:relative` refusal. This does not resolve publication barrier or exact-set correctness gaps; held helper authorization remains separate. |
| DR02, DR09 | Share exact state freeze/data-path leaves and controlled Node harness I/O. | Preserve descriptor/getter behavior and scenario/transaction ownership. Harness modules are public support code; media JSON sending has a distinct string-input policy. |

## Boundaries retained by caller evidence

The 18 retained records protect concrete different outcomes, public assembly or
unfinished replacement gates; they do not endorse every existing branch indefinitely.

| IDs | Why consolidation/deletion is not currently justified |
| --- | --- |
| DV06, DR13 | Stdlib named assembly reduces generated callers' package knowledge; shared contract types reduce duplicate declarations. Type-only imports add no runtime call layer. Some contracts also export real version constants. |
| DV07, DV10 | Prepared owner/liveness/coverage admission and trace comparison are not a second arithmetic core. Transport shape/carrier rejection and owner semantic validation protect different ingress boundaries. |
| DV11, DD-008, DR10 | Live TS/default donors, native alternatives and extracted TS conformance candidates are deliberately coexisting. Root Work-kernel exports facts, not decisions; built/direct-path and oracle obligations still exist. No automatic backend adoption or TS deletion. |
| DC-05, DC-09 | Receipt admission, staging serialization, replay hashing and service playback have different value/error domains. Log-object and provider-text redaction protect different sinks. A universal JSON/redaction abstraction can weaken them. |
| DC-07, DD-013 | Bound invokers remove per-call registry/store plumbing; transaction/join guards enforce different authority rules. Staged checks before DDL and direct assembly admission are separate entry points. |
| DC-08, DC-10, DD-005, DD-006 | CSV adapters use one library grammar but retain advisory/authoritative outcomes. Identity/signal wrappers own length/deadline policy. Raw-map compensation and CJS loadability answer questions the selected libraries do not fully answer. |
| DD-011, DD-014, DD-016 | Production loaders have actual default routes and relative import bases. Conditional exported fanout/dispatch seams have programme/public obligations. A general loader or CLI parser layer needs an actual complexity benefit before replacement. |

## Evidence, review and limits

The audit reuses the [395-file responsibility inventory](../responsibility-callers/README.md)
across all 13 package owners, the baseline classifications and the preceding contract,
library-fit and branch audits. It screened 313 TS files with TypeScript 5.9.3 syntax
only and manually inspected selected Rust preludes/callers. Not every inventoried
file received a new line-by-line semantic review. The source index includes one binary
inventory asset, which is hashed but not parsed as code.

The syntax screen found **67 cross-file exact-token body groups** and **433 single-return
call syntax seeds**. Tokens preserve identifiers/literals but do not resolve closures,
types, helpers or effects. Nested function groups overlap. Callback seeds and public
binding helpers are not automatically unnecessary wrappers. All 67 duplicate groups
map to reviewed records; no count is a deletion or production-LOC estimate.

Finite investigations and independent cross-family challenges used **Sol medium**
(`gpt-6.1-sol`), as requested. The [review record](review.json) contains 23 findings across
three challenges; conclusions were visible, so these were not clean-room reviews.
Corrections include a false scenario parser caller, type-only import reachability,
getter-order differences, readonly shape/public-plan observations, duplicate-range
accounting and permissive numeric spellings. The authoritative candidates incorporate
them; reviews retain the correction history.

[Verification](verification.json) checks 459 repository inputs, two pinned upstream
inputs, 476 candidate/caller ranges and 150 screen ranges. Package inputs equal the
frozen/current source at verification. There are no builds, tests, installations,
runtime probes, benchmarks or new host qualification. Static observations cannot prove
external callers absent, dynamic deployment unreachable, performance improved, or an
installed closure smaller. No quantitative savings or maintenance-hour forecast is made.

Reproduce the evidence checks:

```sh
python3 docs/research/package-library-audit-20261006/duplication-layers/verify.py --repo . --external
node docs/research/package-library-audit-20261006/duplication-layers/screen.cjs . /private/tmp/canlang-duplication-screen-recheck.json
```

The screen requires the existing TypeScript dependency; it imports only the parser and
reads frozen source. Neither command imports or executes package implementation.
The [decision record](decision-record.md) preserves proposed ownership and gates.
No living file-tree checkpoint or canonical task acceptance advances from this audit.
