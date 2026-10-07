# Compiler responsibility coverage — audit Step 2

The structural inventory accounts for every tracked compiler path. The single authoritative [coverage ledger](coverage.jsonl) records current responsibility bands, named API declarations, test families and interfaces. A fresh Sol medium reviewer accepted the inventory after bounded corrections; [review receipts](review.json) preserve the initial findings and final delta checks. This step maps duties and review scope; it does not qualify semantic correctness, test adequacy or complete workflows.

Compiler source remains pinned to `1fd07722090fe70228a6b661e3c6e136275ca84b`. The observation head is `16def5f95f51dbfb158d0ac086323ac256ee1c6d`; intervening commits changed documentation. All 107 compiler file hashes match the [Step 1 inventory](../baseline-verification/compiler-inventory.jsonl). Dependency/catalog/runtime/toolchain inputs and earlier executed evidence remain in [Step 1](../baseline-verification/README.md). The additional 31 supporting interface files have hashes in the ledger. They are narrow cross-owner references, not a new package/editor audit.

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

The ledger's scope row defines separate structural, workflow, semantic, independent-mapping and target-allocation states. Each path inherits them; interfaces remain indexed/untraced. There is no uncovered tracked path, but there is substantial unreviewed behavior:

- Trace real CLI/library/editor/generated-output workflows and complete caller closure in Step 3. Existing Step 1 consumer receipts retain their bounded scope.
- Review owning contracts and public preconditions, including source/checked/catalog pairing, carrier fields/variants/trait callbacks, raw JSON/IDs, exact Can values, URI identity, coordinates and output order. An exported helper is not automatically a frozen compatibility obligation.
- Review semantic branches, incomplete/recovery behavior, authority/evaluation order and resource/lifecycle/host policies in later steps. Documented guarantees are claims until their witnesses are qualified.
- Assess test independence and coverage, optional prerequisite skips, macro-generated tests, mocks and actual consumer execution. Test names and API calls only identify intended witnesses.
- Reconcile task recipes/CI headers with executable steps and qualify declared profiles separately. Package/editor sources remain with their owners.

The ignored `compiler/target/` tree contains generated build/cache artifacts, whose provenance is handled by Step 1 receipts. The ignored `.DS_Store` is OS metadata. Neither is omitted compiler implementation. Independent inventory review is accepted; semantic/workflow states remain open. The current [validation receipt](validation.json) checks exact path equality, hashes, all bands/anchors, test links and supporting interface pins.

Luna low mapped paths/test families; Sol medium mapped technical boundaries and large-test bands. Root integrated the ledger and coordinates the single documentation writer. Future packets must release one writer per defining file; `types.rs`, `cli.rs`, shared JSON/serializers and Cargo changes require serialized ownership. Escalation was unnecessary.

The [existing living plan](../../../ideal-filetree-plan.md) and [compiler review](../../../ideal-filetree-plan/reviews/compiler.md) remain the canonical target/ownership map. This is current compiler-scoped coverage evidence. Historical ranges in that plan are not reused as current coverage, no architectural allocation is selected here, and its merge checkpoint remains unchanged.
