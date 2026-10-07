# Complete library integrations — audit Step 6

The [single coverage ledger](coverage.jsonl) now accounts for all seven direct compiler dependencies in 22 engine/consumer-family result records. [Counts](integration-counts.json) join shared families, recursive caller graphs and public/CLI/editor routes; [validation](integration-validation.json) checks source ranges, inline-test exclusions, pins and union arithmetic. [Independent review](integration-review.json) accepts the bounded map after caller/count corrections. Recommendations are planning results, not implementation or API releases.

Compiler source remains `1fd07722090fe70228a6b661e3c6e136275ca84b`, with collection head `e9524b39`. Forty-nine supporting files are pinned in addition to the inherited 107-path inventory. Cached pinned library source supplies primary evidence for the current public APIs and implementation assumptions. Manifest/lock and the prior native feature receipt match; no upgrade, build, runtime or footprint experiment was performed in this step.

## What the counts mean

Inclusive physical ranges include comments/blanks and de-duplicate nested/shared lines. The selected production closure covers **383 source units, 25 source files and 15,841 physical lines**. That includes domain DTOs, admission rules, callback implementations and large command/emitter handlers. It is **not 15,841 lines of library overhead or removable code**. A source unit can be an exact function/type or an explicitly grouped implementation/context block; it is not a semantic complexity measure.

Closure stops at named public APIs and actual command/editor/first-consumer boundaries. All internal direct callers and recorded intermediate routes are accounted for; unknown external Rust callers remain unresolved support obligations. Serde derives/trait callbacks are explicit joins. Same-owner inverse graphs are lexical, independently source-challenged, rather than Rust compiler call-graph output. External package bodies are pinned boundary evidence and excluded from compiler production totals; this does not re-audit all package workflows.

| Integration/family | Result | Integration slice / linked compiler closure, physical lines |
| --- | --- | --- |
| SHA2 | **retain** | 5 / 1,439; one digest wrapper, five direct caller functions |
| tempfile | **retain** | 99 / 490; five policy functions and one metadata carrier, two direct writer callers |
| Ordinary URL values | **retain** | 7 / 7,233; one parser/scheme validator; typechecking routes include 86 owner functions |
| LSP URL display projection | **retain** | 47 / 666; three functions, two notification use sites |
| Shared typed JSON output | **retain** | 38 / 8,322; 15 production-compiled direct caller functions |
| JSON input engine | **defer** | 221 / 2,175; bounded ordered/raw visitor and reader coupling |
| JSON views/accessors/rendering | **retain** | 85 / 2,241; preserve public/raw/duplicate semantics |
| Catalog JSON admission | **retain** | 325 / 983; owning catalog shape/signature rules |
| Diagnostic JSON | **retain** | 101 / 791; typed output projections |
| Docs JSON compatibility views | **defer** | 279 / 545; typed schema plus legacy public bridge |
| Policy JSON layout | **defer** | 252 / 517; future simplification requires an owning layout revision |
| Explain JSON | **retain** | 20 / 234; direct typed projection |
| Fix JSON | **retain** | 95 / 365; live CLI typed route plus public fragment helpers |
| JS string serialization | **retain** | 3 / 3,768; 37 direct caller functions, 122 use sites including a callback |
| JS descriptor serialization | **retain** | 258 / 838; legitimate domain DTOs and public fragment support |
| JS encoded default representation | **defer** | 167 / 1,155; typed literal → string → RawValue bridge |
| Descriptor fallback policies | **defer** | 755 / 1,250; domain admission/vocabulary, not generic JSON fallback |
| Artifact typed JSON | **retain** | 174 / 869; source maps borrowed as typed values, zero map RawValue joins |
| BDD JSON/string emission | **simplify** | 3 / 695; consolidate one duplicate private quote helper |
| LSP typed output | **retain** | 145 / 1,520; server handlers counted as domain caller context separately |
| LSP JSON admission/framing | **retain** | 319 / 936; input duties separate from output DTO library |
| Source-map integration | **defer** | 193 / 789; retain qualified codec/contract, reopen extraction/public helper packets |

Slices include necessary domain/context code and are not uniformly adapters. Linked closures overlap and must not be summed. Exact units, current mechanisms, all public helpers, fallback/error paths, owners and retirement gates are in the ledger.

## Findings and explicit retirement targets

| Packet | Current mechanism / measurable target | Gate and present result |
| --- | --- | --- |
| BDD quote consolidation | Retire private `bdd::js_string` (3 physical lines); seven caller functions/21 uses continue through one shared quote owner. Require **at least 3 net production lines deleted across both owners**, after imports/visibility/replacement changes. | **Simplify** as a bounded planning packet. Same output/error policy; shared writer coordination and required BDD/JS consumers. Threshold is an acceptance budget, not a demonstrated saving. |
| JSON reader coupling | Retire `ValueOrigin`, `InputReader`, origin-adjusted entry/error cursor accounting and raw numeric extraction's dependence on one-byte lookahead. Require **at least 40 net production lines deleted** across input/catalog/LSP/public adapters, with no fallback grammar engine. | **Defer** supported replacement selection. Keep parse-time depth, duplicate/first-match behavior, lexical numbers, strict strings/surrogates and required error anchors. A blanket `serde_json::Value` loses required information. |
| Docs legacy views | Remove 13 public `to_json` method bodies plus `reference_json`: **44 counted production body lines**, one serialize→parse site and 13 view entrypoints; conditional net target **44**. | **Defer** public support/API decision and independent consumer/oracle qualification. Live docs already serialize typed values directly. Repository nonuse does not waive public support. |
| Policy layout engine | Retire `PolicyFormatter`, `Layout`, `indent` and formatter state callbacks: **142 counted physical production lines**, custom container/key/layout engine; conditional net target **120** after replacement. | **Defer now; simplify after an owning revision.** Current byte/readability/newline guards remain binding; a consumer parsing objects does not release them. |
| Default JSON string bridge | Retire encoded `Literal(String)` storage/revalidation route: one typed literal→JSON text→RawValue parse site becomes zero; conditional net target **10** across IR/JS/artifact/public helpers. | **Defer** representation/public API choice. Preserve exact decimal-string values/scale, object/array shape, null and omission; count all substitute DTO/compatibility code. |
| Source-map extraction | Retire `EncodedMappings`, temporary buffer, one library full-map encoding→projection parse and two `expect` sites. Target **16 inclusive physical lines** (12 executable/derive lines plus four comments); supported replacement must delete **at least 1 net production line** across closure. | **Defer** supported API/representation qualification. Current public library exposes encoded mappings through its writer; private encoder selection is not a qualified solution. |
| Public map decoder | Retire/move from production one `DecodedSegment` and three decode/delta/guard functions: **85 production declaration lines**, four mechanisms. | **Defer** public API and independent oracle decision. A test-only move reduces production by 85 but can delete zero repository lines; do not report it as total code removal. |
| Legacy LSP render builders | Consolidate `response_ok`, `response_err`, `notification`: **29 current declaration lines**, two internally live builders and one public/test-only helper; no positive net claim until replacement counted. | **Defer** byte/public helper and hand-built Json support policy. Typed payload emission already avoids reparsing. ID rendering→RawValue revalidation remains one narrow site. |
| Public descriptor/fix fragments | Conditional removal of 11 unused JS fragment methods plus `models_json` (**41 total body lines** across 12 helpers, including four-arm static server initializer) and three fix string wrappers (**9 body lines**). | **Retain current support; defer retirement.** Production-compiled calls inside unused public methods are distinct from internally exercised routes. DTOs and live `operations_json` remain. |
| LSP duplicate position carriers | Two public backend types plus one range adapter: **18 current declaration lines** potentially removable. | **Retain/defer API migration.** Backend callbacks, source-owned UTF16 conversion and URI identities must remain; no direct library type substitution selected. |

All targets are **proposed acceptance thresholds**, not candidate measurements or a sum of promised savings. Every replacement, fallback, shared helper, compatibility API and dependency change stays inside the closure budget. A packet that cannot meet its net/owned-mechanism target must revise its approach or retain the current implementation. Zero for a retained integration means no justified further deletion, not a requirement to force one.

## Necessary boundaries and upgrade obligations

SHA2 has one engine; source/revision/migration framing and stale-fix comparisons are callers' policies. Tempfile owns allocation/cleanup; mode, before/after admission, existing versus missing entry replacement and fmt/docs distinctions remain compiler policies. There is no parallel predictable-temp allocator. Ordinary URL admission delegates grammar to URL and retains authored text; URI conversion only derives display metadata, without filesystem/import reading or changing protocol identity.

The custom six-variant `Json` tree is structurally similar to general JSON values but deliberately preserves member multiplicity/order and raw numeric lexemes. It is not evidence of copied library internals. The reader bridge calls public Serde APIs while relying on private `IoRead`/container lookahead behavior and native error suffix formatting. Requalify those assumptions on upgrades. The standard JSON grammar predecessor is retired; current visitor/lexeme/error/depth machinery remains a costly compatibility boundary worth reopening.

Typed wire DTOs implement owning compiler/runtime contracts rather than copies of Serde types. Current LSP output has six always-String URI envelopes, a raw semantic-token vector and two generic JSON-RPC envelopes; library DTOs own the remaining fields. There is no standard/exceptional URI serializer branch left to retire. Callback/domain types carry supported shapes that do not coincide with complete protocol types. Library field/enum use is public; no private LSP API coupling was found.

Can's minimal public `SourceMap` preserves source snapshots/order/content and byte-coordinate contract. Collision-free registration keys plus `set_source` depend on pinned builder registration behavior even though the calls are public. Its extraction roundtrip is incidental; source/name ID translation and final typed artifact borrowing are necessary. Runtime lookup, rewritten map composition, invalid-map handling and mapped exception frames are named first consumers. Testkit's public location formatter chain has no current production reporting caller; prior probe qualification does not establish one. Generated push versus physical-line attribution remains the Step 5 gap.

No Rust private values-core linkage or failed locale candidate is adopted. ICU locale data in the lock graph is transitive URL/IDNA data, not compiler Locale migration. CLI/ICU/temporal/graph/position candidate outcomes and L-F03 remain their existing retain/defer gates. New consequential support/layout/carrier alternatives need verified-context JEV consultation when released; this audit selects no such alternative and does not retry prior rejected transmissions.

## Baseline, review and scope

[Whole compiler delta](integration-evidence/production-delta.json) replays original `309644a` versus pinned current source: **2,067 production lines removed, 2,203 added; 69,119→69,255, net +136**. Comments/blanks count; exact inline `cfg(test)` items do not. Mixed-file changes include correctness and other-owner work, so this is not a causal per-library cost allocation. The reduction criterion remains unmet. This step changes production by zero.

The first delta attempt failed its reconciliation assertion because same-text diff pairs could change production/test classification; it wrote no success receipt. [Retained attempt](integration-evidence/delta-attempt1.py) and [transcribed failure](integration-evidence/delta-attempt1.stderr) make that visible. The corrected counter accounts for those transitions and independently reconciles both snapshots. Published counter/catalogue/delta/validator scripts use the existing checkout; their replay is audit evidence, not compiler behavior execution.

Sol high owns the uncertain JSON compatibility investigation; Sol medium owns protocol/maps, independent family reviews and thin-boundary challenge; Luna medium replays inventory/counts. The same-day [researched allocation](../model-allocation-20261007.md) is reused, without an optimal-setting claim. Independent reviews identify missing routing/consumer bodies, correct artifact map typing and distinguish contextual slices from overhead. Final integrated review accepts the bounded map, with all 499 inherited/current pin references and linked closure counts reconciled. The public fragment target is 11 methods plus `models_json`, 12 helpers/41 body lines. [Fresh published-tool replay](integration-evidence/tool-replay.json) passes counter/catalogue/delta commands; no compiler behavior was executed.

No source/API/contract/dependency/host policy, merge or living-plan checkpoint change occurs. Full semantic correctness, upgrade/profile/performance costs, arbitrary external users and installed/original-app/editor/runtime qualification remain separate audit work.
