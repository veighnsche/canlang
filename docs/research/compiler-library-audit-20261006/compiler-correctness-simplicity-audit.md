# Compiler correctness, ownership and simplicity audit

**Proposed audit procedure, 2026-10-07.** The user asks for compiler-wide steps after the library programme qualified behavior but failed to demonstrate aggregate production reduction. This document specifies the audit; executed Step 1–3 packets below have bounded declared scope, and later steps remain proposed. It authorizes no new framework migration. Preparation includes targeted source tracing, an independent challenge of audit questions and correction of the prior aggregate measurement. The existing [living file-tree plan](../../ideal-filetree-plan.md) remains the canonical responsibility/task map; this is its compiler-scoped supporting procedure, not a second master plan.

The goal is one owner for each standard mechanism and each Can semantic fact, with small, justified boundaries between them. Libraries should own their mechanisms through supported public APIs; Can should own language rules, diagnostics and product contracts. An adapter earns its place by translating a real boundary. Counting adapters or minimizing lines alone cannot select the design. A small custom mechanism can be simpler than a library plus extensive glue.

Use economical workers throughout: [existing researched allocation](model-allocation-20261007.md), Luna low/medium for inventories, arithmetic and released checks; Sol low for bounded routine edits; Sol medium for semantic tracing and independent review. Escalate a bounded question only after concrete evidence shows the cheaper allocation is insufficient. Root coordinates Git, shared declarations and decisions; one writer per defining file, with independent review before acceptance. Package/runtime owners may be consulted or read for evidence; compiler packets do not authorize edits to their work. Step outputs are views of one compact ledger with links to existing evidence, not requirements for sixteen new documents.

## Ordered steps

### 1. Verify the starting evidence and freeze the scope

Pin compiler source and dirty changes, Cargo/features/toolchain, catalog contents, runtime/package exports, actual consumers and supported host profiles. Separate the original programme, R01 and subsequent other-owner changes. Check command exit status, artifact freshness, skipped bodies and measurement definitions before trusting old receipts. Reuse verified evidence without rerunning unrelated suites. The corrected [production ledger](production-reduction/README.md) shows +181 implementation lines before R01, +130 after; the earlier +22/−29 claims are invalid. These are gross physical lines, not executable LOC or complexity.

**Output:** reproducible starting inputs and an evidence ledger marking verified, invalid, stale and unqualified claims. **Allocation:** Luna low for pins/counts; Sol medium for interpreting disputed evidence.

**Executed:** [Step 1 baseline and evidence](baseline-verification/README.md) pins current compiler/dependency/catalog/runtime/tool inputs, corrects category counts, classifies prior receipts and captures a fresh native debug build plus bounded six-test consumer replay. Whole-current qualification and independent per-run temporal reconstruction retain their explicit limits. This completion does not execute Steps 2–15.

### 2. Build complete responsibility coverage

Inventory every compiler source, test, fixture, build/configuration file, completion script and public recipe, plus relevant external joins. Establish a finite initial responsibility list, including public/critical declarations and mechanisms; large mixed files need several slices. Assign owners to these slices, without requiring a paperwork record per declaration. Expand a slice when concrete evidence reveals another dependency or omitted workflow. Record structural, workflow, independent-review and model/writer coverage separately. File inspection alone is insufficient; mark unreviewed branches, interfaces and joins explicitly. Do not treat a previous utility audit as complete semantic coverage or let speculative edges turn the audit into an unlimited investigation.

**Output:** one coverage ledger linked into the existing living-plan responsibilities. **Allocation:** Luna low for path/symbol inventory; Sol medium for responsibility boundaries.

**Executed:** [Step 2 responsibility map](responsibility-map/README.md) accounts for all 107 tracked paths with 544 full-span bands, including 327 source bands and behavior/setup divisions of large and mixed test files. One ledger indexes named public/restricted declarations, recipes and 24 interfaces, with 31 supporting input pins. A fresh independent reviewer accepts structural inventory after visibility, prerequisite, consumer-link and mixed-test corrections. Workflow tracing, semantic/API contract review and test adequacy remain open; this completion does not execute Steps 3–15 or select new architecture.

### 3. Trace real user workflows through the compiler

Trace `check`, compile/artifacts, lint/fixes, formatting, docs/references, policy/explain, generated BDD and editor/LSP from ingress to the actual consuming path. Include thin CLI `run`/`test`/`build`/`deploy`/`activate` argument, process and exit forwarding, and public library entrypoints used without the CLI. Include valid, rejected, incomplete and disconnected cases. Trace source/catalog admission, parse/recovery, resolution, type/effect/authority analysis, lowering, dependency selection, serialization and consumption. Preserve original app acceptance and explicit prerequisites; a synthetic complete result, reduced fixture or accepted rejection does not prove a full application works.

**Output:** workflow-to-owner-to-evidence matrix, with unresolved joins rather than blanket product completion. **Allocation:** Sol medium; Luna low for existing receipt cross-references.

**Executed:** [Step 3 workflow trace](responsibility-map/workflows.md) extends the same coverage ledger with 18 CLI/library/editor/generated-consumer routes, valid/malformed/incomplete/failed outcomes, exact source ownership, independent targeted cross-review and bounded current witnesses. Fresh native focused replay reports 209 passes in 15 harnesses with one mode `4750` body skip; separate receipts qualify 39 real-compiler LSP capability checks, 11 freshly compiled/mocked extension startup checks and actual built-platform forwarding probes. Public provenance/completeness, client version loss, generated-test CLI integration, report/verdict endpoints, subprocess/replacement and other-host/product gaps remain explicit. This completes tracing at its declared scope, not all semantic branches or Steps 4–15; no fixes or new policies are selected.

### 4. Challenge compatibility obligations before designing adapters

For every boundary, locate the actual owning declaration and consumer. Classify intended byte equality, semantic equality, Can policy, supported public API, demonstrably wrong behavior, accidental implementation detail and unresolved policy. Ask who requires duplicate-member first-match behavior, raw number spellings, authored URI identity, output ordering and coordinate units. A helper used by its own tests is not automatically a supported public contract. Preserve intentional distinctions such as decimal strings, null versus omission and file identity; do not preserve malformed protocol admission merely because it existed.

**Output:** boundary contracts with witnesses and removable accidental obligations. Consequential new policy alternatives need verified-context JEV consultation under AGENTS.md; a blocked decision stops only its dependent packet. **Allocation:** Sol medium; justified high for a concrete unresolved cross-owner decision.

### 5. Map representations and semantic ownership

Follow source → tokens/CST → resolved and checked facts → IR → JavaScript/artifact/wire output. Find facts recomputed in later stages, parallel type families, shadow lookup tables, reparsing and repeated normalization. Check source/revision/catalog provenance: can callers pair checked facts with changed text, reordered files or another catalog? Specify and enforce public preconditions or reject mismatches. Retain stage-specific forms when they carry different information; prove duplication before consolidation.

**Output:** representation/conversion map naming the single authority for each shared fact and each required conversion. **Allocation:** Sol medium.

### 6. Review each library integration as a complete implementation

For JSON, URL, SHA2, tempfile, Serde output, LSP types and source maps, account for the full production caller closure, adapters, fallback paths, feature graph and release cost. Look for copied library types, serialization followed by parsing, raw fragments rebuilt as strings, generic compatibility engines, duplicate standard/exceptional branches and reliance on private implementation details. Compare simplifying the adapter, using the public library representation directly, retaining a smaller custom mechanism and undoing an adoption while preserving correctness repairs. Measure equivalent supported outcomes; do not move code, minify it or hide it in generated files/macros.

Start with concrete leads: JSON reader/error-offset coupling; ordered/raw rendering and validation; source-map serialization/parsing to extract mappings and source/name ID translation; duplicated output metadata; test-facing public helper obligations. R01 already removed duplicate LSP URI serializer branches. The SHA wrapper and file replacement policy are examples of potentially necessary thin boundaries, not automatic findings.

**Output per integration:** keep/simplify/replace/defer decision, gross production removed/added, mechanisms/control flow retired, remaining policy and upgrade obligations. Before releasing work, state its reduction target and count method across the complete production closure. Record the whole compiler baseline and attributable programme aggregate too; a local saving does not close an aggregate still above baseline. Separate unrelated features and necessary correctness growth explicitly. **Allocation:** Sol medium for the comparison; Sol low for released local edits, independent Sol medium review.

### 7. Audit lexical, grammatical and recovery correctness

Map every admitted syntax form to checking and lowering, including defaults, descriptions, metadata and interpolation. Inspect Unicode/escapes, layout, malformed tokens, EOF, CRLF and source anchors. Test whether malformed declarations or headers hide independent valid-sibling diagnostics, and whether dependent cascades are suppressed locally. Account for the other owner's newly committed recovery repair rather than rediscovering or overwriting it. Complete input availability does not prove complete semantic coverage.

**Output:** feature-to-stage matrix and minimal outcome regressions for uncovered branches. **Allocation:** Sol medium; Sol low for independently specified small fixtures.

### 8. Audit resolution, types, effects and authority rules

Check name/import scopes, declaration identity, overload resolution, argument binding, inference, nullability, contextual values, permissions/effects and fixture/scenario rules. Compare duplicate owner policies for values, ICU, locale, temporal data and catalog aliases against actual package exports and the language design. Exercise ambiguous/same-arity overloads, graph cycles and chains reaching cycles, unavailable catalog entries and invalid declarations. Trace diagnostic multiplicity/order and deduplication: the same code and anchor need not represent the same finding.

**Output:** independently specified semantic witnesses and a named authority for shared policies, with existing locale/ICU/graph gates preserved. **Allocation:** Sol medium; high only for released policy disputes.

### 9. Audit checked-fact consumption, lowering and generated execution

Ensure lowering consumes established facts rather than independently resolving calls or re-inferring semantics. Compare resolved overload/argument binding with IR's selection, including same-arity signatures. Execute observable evaluation-order cases: named arguments, short-circuiting, async calls, query predicates/projections, interpolation, guards and defaults. Check failure paths when facts are missing or forms unsupported: incomplete/erroneous results must fail the real shipping gate, rather than relying on a generated throw placeholder. Verify prod and test-only dependency requirements, imports and helper availability through the actual catalog/runtime path.

**Output:** source-to-runtime witnesses plus explicit completeness and shipping invariants. **Allocation:** Sol medium; separate economical fixture execution from semantic review.

### 10. Audit output, identity and source transformations

Cover exact numeric precision/authored scale, string decoding/escaping, identifiers versus JavaScript expressions, optional fields, order/layout/newlines, documentation embedding and source attribution. Test source-map source/name order, duplicate paths, unmapped segments and actual consuming coordinates independently of the encoder. Distinguish Can byte spans, generated coordinates, negotiated LSP UTF16 positions, filesystem paths, display paths and non-file URI identities. Consolidate conversion through the relevant owner rather than imposing one unit or normalization on every domain.

For formatting and lint fixes, independently verify semantic preservation, contracted comment/trivia preservation, idempotence, noninterference with unrelated declarations and stale-source rejection. Check that diagnostics and replacement ranges refer to the same source revision and that malformed inputs cannot trigger an unintended rewrite. Successful serialization or replacement alone does not qualify a source transformation.

**Output:** output-family/identity compatibility matrix with real consumers and edge witnesses. **Allocation:** Sol medium; Sol low for released serializer fixture checks.

### 11. Audit IDE state and protocol lifecycle

Review initialization, request IDs, document versions, changes, diagnostics, edits, stale results, cancellation, close, shutdown, exit and disconnect. Trace catalog/workspace invalidation, single-file versus cross-file scope, multi-root identity and client capability/position negotiation. Exercise the real framed process and actual client where client behavior matters. Check long edit sessions for append-only source storage, lingering jobs and other resource growth. Reuse the recently repaired editor activation/update witnesses; they qualify their declared scope, not cross-file analysis or per-document catalog switching.

**Output:** lifecycle/state diagram and stale/invalidated-result witnesses, with declared editor limitations. **Allocation:** Sol medium; Luna medium for released process checks.

### 12. Audit failure, resource and host boundaries

Find `unwrap`/`expect`/panic paths and lossy/truncating conversions reachable from source, catalogs, protocol, paths and public APIs. Check overflow, recursion, wide containers, graph work and bounded source/catalog/body/header admission while reading, not only after building an unbounded structure. LSP `read_until` headers are a concrete inspection lead: the body limit alone does not establish a header limit. Define warranted limits before choosing a fix; this is not yet an executed resource defect. Distinguish binary panic interception from library API behavior.

Also exercise file replacement modes, stale-fix/race handling, cleanup and failure before replacement; exact CLI passthrough/error/exit behavior; symlink/hardlink/path policy and supported hosts. Mode tests or successful rename do not prove ACL/ownership or crash durability. Check release/build metadata in linked worktrees and packed refs where supported.

**Output:** reachable-failure/resource inventory, selected bounded regressions and a host/policy claims matrix. **Allocation:** Sol medium; Luna medium for released host/check receipts.

### 13. Audit the tests and oracles themselves

Identify snapshots generated by the same implementation, encoder/decoder round trips, API mocks that omit real methods, public probes that invent completeness and tests that skip internally while the harness passes. Tie each claimed outcome to independent expected behavior, actual owner behavior or a separately qualified consumer. Add focused properties/metamorphic or fuzz cases where the input/state space warrants them: malformed JSON/Unicode/framing, recovery and state sequences, deterministic output and numeric boundaries. Retain exact regressions for real defects; avoid mirrored tests and large test infrastructure with no distinct outcome coverage.

**Output:** outcome-to-oracle-to-executed-body ledger and a bounded missing-regression list. **Allocation:** Sol medium for oracle review; Luna low/medium for execution/receipt checks.

### 14. Audit dependencies, upgrades and architecture costs

Check pinned versions/features, active and supported-host transitive closures, dependency ownership and maintenance/upgrade constraints. Requalify any integration coupled to private internals and verify current primary documentation/source when selecting an API. Compare build/release footprint and representative compiler/editor workloads at equivalent inputs; distinguish warm runs, cold runs and unexecuted hosts. Look for repeated parse/resolution, dependency cycles, oversized mixed responsibilities, unnecessary public exposure and dead helpers. A file move does not remove an ownership problem; a cache requires correct source/catalog invalidation. Rowan, Salsa and a JS AST remain separate proposals requiring measured benefit.

**Output:** dependency/upgrade ledger and small target ownership changes, with adopt/retain/defer results rather than a mandatory library list. **Allocation:** Sol medium for tradeoffs; Luna medium for repeatable profiles.

### 15. Challenge coverage independently and turn findings into packets

A reviewer traces missed workflows and interfaces independently of the first audit's conclusions, challenging major conclusions and coverage rather than repeating every inventory or receipt. Reconcile every in-scope path/responsibility and workflow join to reviewed evidence or an explicit gap. Prioritize reproduced wrong programs, crashes, lost diagnostics, authority/admission mistakes, stale edits and warranted resource failures; rank maintenance reductions separately by demonstrated duplication and upgrade cost. Keep confirmed defects, code-level observations, hypotheses, intentional policy and unfinished capability separate. Do not convert every hypothetical edge into a repair requirement.

Each actionable packet records its evidence/confidence, owning declarations, actual callers/consumers, exact writer files, preconditions, independent expected behavior, intended change/retirement, dependencies and acceptance commands. Separate correctness repairs from library simplification. One manifest/lock integrator and serialized writers for shared `types.rs`, `cli.rs`, JSON and output helpers. Failed candidates and unresolved policy decisions must not block unrelated packets.

**Output:** finite prioritized repair packets, explicit retain/defer decisions and uncovered-scope ledger. **Allocation:** independent Sol medium; Luna low for coverage reconciliation. This completes the audit's planning stage, not implementation.

### 16. Downstream implementation and release qualification

This step is downstream guidance after the audit's planning exit in Step 15; it is not work to perform during this audit. Root releases an implementation packet within the user's authorized work when its exact writers, dependencies, contract and independent acceptance are concrete. Audit preparation alone supplies no new implementation authority; existing session authorization continues to apply without another approval ceremony. Land small coherent checked commits, independently review their complete caller closure, remove retired predecessors and avoid permanent dual engines. A simplification packet exits only with equivalent required outcomes, its declared net production-reduction target across the complete closure and demonstrably fewer owned mechanisms; if glue remains as costly as the predecessor, revise or reject it. Assess the programme aggregate separately. A necessary correctness repair may grow production code but must be classified honestly. No reduction target permits weakening language or consumer contracts.

For final integration run applicable suites, `cargo test --locked`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, release/public recipes and changed actual CLI/LSP/artifact/emitted-code consumers with pinned inputs. Preserve required installed/original-app acceptance and its unresolved owner prerequisites. Review final dependencies, unused helpers and source/test/data/build measurements separately. Update supporting decisions/README/task references; after an actual merge reconcile the existing living plan against all accumulated changes, advancing its checkpoint only when the required review is complete.

**Output:** independently reviewed compiler release at its declared scope and honest remaining gaps. **Allocation:** Luna low/medium for checks/receipts; Sol medium for substantive final review; justify escalation.

## Required audit record and exit

Keep one compact ledger with these fields: responsibility/workflow, defining declaration, caller/consumer closure, owning contract, finding class/severity/confidence, reproducible evidence and pins, intended owner/retirement, packet/writer, dependencies, acceptance and unresolved scope. Link existing evidence rather than duplicating full receipts. Use the living plan's coverage/decision structure when the audit is executed; no checkpoint changes during preparation.

The audit exits when every declared compiler responsibility and workflow join has a review result or an explicit bounded gap; confirmed findings have implementable packets; proposed changes have independent acceptance; and a separate reviewer has challenged coverage. It cannot establish that every possible bug has been found. The operational promise is visible coverage and a repair path, rather than an unsupported claim that the compiler is now universally correct.

Existing Pass10 evidence stays scoped to its frozen source. The newer sibling-diagnostic/editor repair is other-owner work and has its own receipt. T37, FP.QUALIFY and FP.INSTALLED-RELEASE remain original product acceptance, not utility-test milestones. Locale replacement, ICU corrections, graph-origin/pound policy and broader path policy retain their recorded outcomes/prerequisites. Previously rejected JEV payload transmission is not retried or treated as approval here. This planning round makes no compiler/package code, dependency, release, publication, merge or living-checkpoint change.

**Preparation review:** economical Sol medium independently challenged coverage and source-grounded leads. Its six requested corrections are incorporated: explicit planning exit; closure/aggregate reduction measurement; one ledger; thin/public workflows; source-transformation invariants; finite responsibility slices. The reviewer accepts the final procedure, with no full audit or product-test claim. Root checked the JSON coupling, source-map projection, header reading and IR argument-binding leads directly. Count replay and documentation/link checks qualify preparation only; compiler/package tracked inputs remain unchanged from the preparation commit `6b8784cb8d06b7de9acc6cf9c435b7f3f954b930`.
