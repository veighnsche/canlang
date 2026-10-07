# Compiler responsibility coverage — audit Steps 2–8 and 10

The structural inventory accounts for every tracked compiler path. The single authoritative [coverage ledger](coverage.jsonl) records current responsibility bands, named API declarations, test families and interfaces. A fresh Sol medium reviewer accepted the inventory after bounded corrections; [review receipts](review.json) preserve the initial findings and final delta checks. Structural inventory maps duties and review scope; it does not qualify semantic correctness or test adequacy. [Step 3 workflow tracing](workflows.md) extends this same ledger with actual consumers and bounded executed witnesses. [Step 4 compatibility challenge](compatibility.md) distinguishes owning outcomes, current public byte promises, migration guards and incidental mechanisms. [Step 5 representations](representations.md) traces stage authorities, conversions, reconstructed facts and source/catalog coherence. [Step 6 integrations](integrations.md) records complete scoped library caller/adapter closures and conditional retirement results. [Step 7 syntax/recovery](syntax.md) maps finite admitted forms through stage owners and records independently corroborated recovery/meaning-loss findings.

Compiler source remains pinned to `1fd07722090fe70228a6b661e3c6e136275ca84b`. The Step 2 inventory observation head is `16def5f95f51dbfb158d0ac086323ac256ee1c6d`; intervening commits changed documentation. All 107 compiler file hashes match the [Step 1 inventory](../baseline-verification/compiler-inventory.jsonl). Dependency/catalog/runtime/toolchain inputs and earlier executed evidence remain in [Step 1](../baseline-verification/README.md). The additional 31 supporting interface files have hashes in the ledger. They are narrow cross-owner references, not a new package/editor audit.

| Inventory | Mapped scope |
| --- | --- |
| Compiler source | 41 Rust files, 327 responsibility bands |
| Tests and fixtures | 52 paths: 47 Rust integration suites, one shared process driver, two `.can` fixtures, Python completion helper and JS map consumer |
| Large test files | Seven files over 1,000 lines, divided into 94 behavior/setup bands; mixed authoring/IDE suites add 24 bands |
| Support | 14 paths: Cargo manifest/lock, build script, three completions, six convention/proposal documents, routing JSON and ignore rule |
| Entire tracked tree | 107 paths, 544 contiguous full-span bands |
| API index | 648 named source declarations/reexports: 612 classified externally reachable, 22 restricted, 14 in private LSP adapter modules |
| Interfaces | Eight front-end joins and 16 root/tool/editor/runtime joins; root recipe values and 31 file pins |

API numbers count named declaration sites, including methods and reexport statements; they are not counts of unique API identities or supported promises. Carrier fields/variants and trait methods remain attached to their owning type/trait and exact source anchor. Method reach follows the owning type: `ExprCtx::bare` remains crate-private despite its method's `pub` keyword. The lexical index is checked against source visibility, not generated from Rust semver tooling. The ledger's 929 explicit `#[test]` sites exclude macro expansion and do not predict the active host test count. No tests/builds were executed during Step 2. The fresh reviewer also checked all 168 indexed inherent public methods against owning-type reach, plus exact recipes, fixture consumers and scope states.

## Responsibility navigation

Each path row gives the defining writer file and stable local slice IDs such as `src/analysis/types.rs#24`. Inclusive line bands partition the entire current file, including imports, scaffolding and inline tests. Bands describe present duties; they do not select file moves. Representative symbols locate each band without creating a paperwork record for every private declaration.

| Responsibility family | Defining owners and interfaces |
| --- | --- |
| Source and diagnostics | `source.rs`: identities, text/hash storage and byte/UTF16 indexes; `diagnostic.rs`: severity, source anchors and text/JSON output |
| Syntax | `syntax/{lexer,layout,cst,parser,mod}.rs`: byte admission, decoded tokens, descriptions/layout, lossless tree/recovery and parse facade |
| Checked facts | `analysis/{catalog,resolve,types,effects,examples,migrate_check,check,mod}.rs`: producer admission, scopes/imports, types/narrowing, effects/authority/disclosure, independent examples, migration consistency and ordered diagnostic orchestration |
| Generated outputs | `codegen/{ir,js,bdd,artifact,sourcemap,mod}.rs`: decoded/lowered facts, executable JS and descriptors, BDD modules, dependency/artifact wire, coordinate attribution/codec and completeness gate |
| Standard JSON mechanism | `json.rs`: bounded library grammar, ordered/raw compatibility representation, typed output/layout helpers; callers remain separate owners |
| Reports and transforms | `docs.rs`, `policy.rs`, `explain.rs`, `format.rs`: checked reference extraction, declared policy reporting, diagnostic guidance and source formatting |
| Lint and fixes | `lint/{driver,rules,mod}.rs`, `ide/fixes.rs`: seven rules, configuration, safe fix production, JSON and stale/range/overlap admission |
| Authoring queries | `ide/{queries,tokens,mod}.rs`: analyzed document snapshot, resolved position queries, completions/outline and shared semantic-token legend/data |
| Protocol and session | `lsp/{server,transport,output,uri,mod}.rs`: byte framing/envelopes/IDs, callbacks/lifecycle/versioned buffers, typed wire and authored URI projection |
| Public execution surfaces | `lib.rs`, `main.rs`, `cli.rs`: library modules/versions, binary panic boundary, command grammar, checked commands, platform forwarding, docs subprocess and replacement ownership |
| Build and shell/tool surfaces | Cargo/build files and completions; root runner/CI recipes; catalog producer/conformance; editor client/providers; platform artifact/docs/policy consumers |

The largest source owners are divided by actual duties: `types.rs` has 38 bands, `ir.rs`/`js.rs` separate carriers, decoders and emission families, and parser/resolver/effects each have distinct productions or analysis phases. Large `codegen.rs`, `b4_check.rs`, analysis, syntax, effects, docs and check suites also separate setup, assertions and behavior families. A whole-file count does not imply all their branches have been reviewed.

The `.can` fixtures are authoring-chain inputs: `AuthoringDemo.can` belongs to `b3_authoring_join.rs`; `s4_fix.can` belongs to `b3_s4.rs` and the external demo script. The JS fixture independently decodes source maps and invokes the actual source consumers. Python drives real Zsh completion machinery. These roles are distinct from emitted application execution.

## Coverage states and remaining scope

The ledger's scope row defines separate structural, workflow, semantic, independent-mapping and target-allocation states. Each path inherits them. Step 3 adds workflow references and 18 consumer-route records; a reference is navigation, not an assertion that every responsibility band or API branch is qualified. There is no uncovered tracked path, but there is substantial unreviewed behavior:

- Use the [Step 3 routes and gaps](workflows.md) to review owning contracts and semantic branches. Actual CLI/library/editor/generated-output endpoints are source-traced, with bounded execution separate; the original application and installed-release prerequisites remain open.
- Review owning contracts and public preconditions, including source/checked/catalog pairing, carrier fields/variants/trait callbacks, raw JSON/IDs, exact Can values, URI identity, coordinates and output order. An exported helper is not automatically a frozen compatibility obligation.
- Review semantic branches, incomplete/recovery behavior, authority/evaluation order and resource/lifecycle/host policies in later steps. Documented guarantees are claims until their witnesses are qualified.
- Assess test independence and coverage, optional prerequisite skips, macro-generated tests, mocks and actual consumer execution. Test names and API calls only identify intended witnesses.
- Reconcile task recipes/CI headers with executable steps and qualify declared profiles separately. Package/editor sources remain with their owners.

The ignored `compiler/target/` tree contains generated build/cache artifacts, whose provenance is handled by Step 1 receipts. The ignored `.DS_Store` is OS metadata. Neither is omitted compiler implementation. Independent inventory review is accepted; semantic acceptance and the Step 3 consumer gaps remain open. The [Step 2 validation receipt](validation.json) preserves its historical ledger hash. [Current extended-ledger validation](workflow-validation.json) checks exact paths, hashes, bands/API/interface anchors, workflow anchors, input pins, slice joins and evidence links.

Luna low mapped paths/test families; Sol medium mapped technical boundaries and large-test bands. Root integrated the ledger and coordinates the single documentation writer. Future packets must release one writer per defining file; `types.rs`, `cli.rs`, shared JSON/serializers and Cargo changes require serialized ownership. Escalation was unnecessary.

The [existing living plan](../../../ideal-filetree-plan.md) and [compiler review](../../../ideal-filetree-plan/reviews/compiler.md) remain the canonical target/ownership map. This is current compiler-scoped coverage evidence. Historical ranges in that plan are not reused as current coverage, no architectural allocation is selected here, and its merge checkpoint remains unchanged.


## Workflow coverage — Step 3

[Workflow navigation](workflows.md) covers all 15 named CLI commands and public module families in 18 routes, including five platform forwarding paths and actual downstream artifact/BDD/docs/policy/editor consumers. The authoritative ledger retains 322 current source anchors and 85 source-trace input pins. Independent economical cross-review and final artifact challenge are captured in [workflow review](workflow-review.json).

Fresh focused native replay reports 209 passes across 15 harnesses with one mode `4750` body skip. Separate receipts record 39 actual-compiler LSP capability checks, 11 freshly compiled/mocked extension startup checks and actual built-platform help/error/staging/count/verdict/refusal probes. Source and emitted runtime inputs are pinned separately; no package rebuild, GUI, positive generated-suite/workerd test, installed-release or remote apply qualification is inferred. Client versions, generated test execution, report endpoints, subprocess/replacement policies and library provenance remain explicit next-step contract/semantic questions.


## Compatibility authority — Step 4

[Compatibility findings](compatibility.md) classify 83 bounded requirements and crosswalk all 26 prior claim groups in the same ledger. All 16 core packets and 18 workflows are linked; 82 supporting source/contract inputs are pinned. Per-path `compatibility_refs` are navigation, not every-branch or every-public-API acceptance. [Independent review](compatibility-review.json) records current public byte promises, corrected docs no-op scope, ICU admission ownership and migration-check coverage; [mechanical validation](compatibility-validation.json) checks the extended ledger.

Required exact values, hashes, URI/source identities, coordinates and deliberately accepted file policy remain distinct from wider ordered/raw carriers and old serializer punctuation. Explicit public reference/fix order and formatter literal/newline guarantees cannot be silently waived. Test-only repository helpers still need an owning public-support decision. Existing migration guards remain in force until explicitly revised; candidate simplifications remain proposals. No source/API/dependency change or fresh execution was made; later semantic/integration/resource/oracle steps and original/installed product prerequisites remain open.


## Representation authority and provenance — Step 5

[Stage/owner navigation](representations.md) maps 35 duties from immutable source/token/CST through resolution, checked tables, IR, JS/BDD/artifacts, reports and actual runtime/testkit admission. Eight selected carrier groups and18 workflow joins stay in the same ledger. These are selected stage duties, not every type field or semantic branch; per-path `representation_refs` remain navigation. [Independent review](representation-review.json) separates necessary stage information from reconstructed names/types/bindings and corrects the emission-only migration checker. [Validation](representation-validation.json) checks37 new supporting pins alongside prior inventory/contract/workflow inputs.

Eight fresh public-API emission cases expose deliberately mixed source/catalog cohorts without rejection, with coherent and immutable-append controls;108 compiler/catalog pins remain unchanged. The normal CLI owned analysis and private borrowed snapshot are distinct. No generated JS, full suite, GUI, installed application or other host was exercised. Repeated parsing, carrier projections and rule differences are inspection leads, without measured workload/reduction or selected public enforcement/cache/API design. Source, dependency and package implementation remain unchanged; package-owner documentation changes are preserved.

## Step 6 integration/retirement status

All seven direct dependency pins are accounted for in 22 result records: 15 retain, six defer, one bounded simplify; no unqualified replacement is selected. The linked closure union covers 383 source units/25 compiler source files/15,841 inclusive physical lines, including domain/caller context rather than library overhead. [Counts](integration-counts.json), [independent review](integration-review.json) and [validation](integration-validation.json) distinguish necessary projections and file/URI/value policy from private reader/registration coupling, legacy views, raw-default revalidation and incidental source-map extraction. Conditional targets include replacements and current public support; no production code is deleted. Fresh published-tool replay and independent arithmetic retain current69,255/original69,119, gross2067removed/2203added/net+136. Support pins and prior source/workflow/representation evidence remain linked; no compiler behavior/build, merge or living checkpoint advancement occurs.


## Syntax, stage coverage and recovery — Step 7

[Syntax findings](syntax.md) add 27 finite stage families, eight open repair packets
and a registry to the same coverage ledger. All 186 full EBNF productions, 119 CST
kinds and four NodeDetail variants are accounted for; custom HeaderKind and
parser-specific key scopes are separate. Fresh native evidence comprises 345
selected harness passes, 50 public stage cases, all 54 corpus stage projections,
16 actual CLI calls and six executed decoded-string/testkit witnesses.
[Independent review](syntax-evidence/cross-review.json) and
[integrated validation](syntax-validation.json) preserve source/execution limits.

The independent-sibling contract still fails in effects and source-tag metadata
collection. Tab captions/children, structured order and corpus declarations can
be lost with compile success. Delimiter synchronization and new feature/profile
support remain separately gated. Whole semantics and per-branch emitted execution
are not certified; these open defects do not invalidate the finite source map.
No compiler/package/dependency/policy change or merge/checkpoint advance occurs.

## Resolution, types, effects and permissions — Step 8

[Semantic findings](semantics.md) add 44 bounded duties and eight classified
repair/qualification records to the same ledger. Resolution/imports/overloads,
binding/inference/nullability/context, effects/authority, actual value owners,
graph scopes, catalog availability and diagnostic aggregation have named source
and consumer ownership, sampled witnesses and explicit gaps. Source cross-review
and [receipt review](semantic-evidence/receipt-review.json) distinguish observed
defects from policy disagreements, copied catalog controls and unexecuted joins.

Fresh native execution has 440 selected passes, 73 retained public API inputs,
12 graph repeats, 70 public owner calls, eight CLI calls and two emitted pure
format functions. Nullable arrays depend incorrectly on element order; recurring
scope misses derives; named format binding and the positional runtime signature
fail. Owner email/temporal/data/presentation disagreements and existing graph/JEV
gates remain visible. [Validation](semantic-validation.json) checks the joined
ledger and captures without converting sampled execution to universal semantic
acceptance. No production/package implementation, merge or checkpoint change
occurs; broader Step 9 execution and later resource/oracle/product scope remain.

## Outputs and source transformations — Step 10

[Output findings](outputs.md) add 35 finite duties and five repair/qualification
records to the same ledger: 15 serialization families, 13 transformations and
seven coordinate/identity boundaries. Exact values, scale, escaping, presence,
order, source revisions, byte spans, UTF16 positions, source-map columns and
authored URI identities have distinct owners and consumer witnesses.

Fresh native evidence has 113 harness passes with one `4750` fixture branch skip,
61 source cases, 18 actual CLI calls and five Node syntax checks. Legal reserved
and context-colliding parameters compile into invalid JS. A tags-only public
diagnostic tie and standards-derived downstream docs escaping defects are
classified separately from comment preservation and unsupported profile gates.
[Independent review](output-evidence/review-transforms.json) and
[validation](output-validation.json) retain corrections and evidence limits.
Structural preservation and selected consumers do not certify all semantics,
runtime attribution or the final release. Step 9 and Steps 11 onward remain
proposed; no production/package implementation, merge or checkpoint changes.
