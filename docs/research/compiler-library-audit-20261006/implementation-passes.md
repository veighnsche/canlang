# Compiler library replacement passes

Repair demonstrated compiler errors first, then replace standardized mechanisms through qualified adapters. The compiler continues to own Can grammar, permissions, effects, exact value policy and lowering. Success means fewer duplicated standard implementations with faithful supported behavior; it is not a target dependency count.

This is the detailed execution proposal accompanying the [audit](README.md), pinned to `309644a6881909d8dba32560bc6711f67e00a7ab`. Refresh affected source and evidence before implementation. The pass numbers below are local planning labels, not new canonical task IDs, accepted completion statuses or releases to the package Rust-port workers.

**Execution update, 2026-10-07:** the [final Pass 10 receipt](pass10/README.md) qualifies the selected core substitutions and links every packet's implemented contract/consumer evidence. The audit's [completion table](README.md#implementation-and-qualification-status) is the current scope ledger; the original preparation/instructions below remain historical planning context. Locale replacement failed its profile gate, conditional mechanisms retain/defer separately, and T37/FP.QUALIFY/FP.INSTALLED-RELEASE remain open. The pass labels do not replace canonical product or package task identities.

**Clarified production-reduction requirement, 2026-10-07:** correctness/retirement qualification does not complete the user's simplification objective. Every further substitution must show a material net reduction across its complete production adapter/caller closure, with equivalent behavior and fewer owned mechanisms; tests, lockfiles and binary size are separate. Do not use formatting, relocation or contract weakening to manufacture a reduction. The [bounded follow-up](production-reduction/README.md) records the first checked LSP projection reduction and the remaining assessment gates. Its economical delegation and coherent commit rules apply to each packet.

## Pass 0 Establish the contracts and regression witnesses

**Priority and effort:** first, bounded preparation. It should produce implementable packets rather than reopen the entire repository audit.

For each packet, record the actual caller closure, owning declarations, defining files, supported host/tool profile, candidate dependency/features and relevant original acceptance. Distinguish intended compatibility from behavior that is demonstrably wrong. Pin the compiler, catalog and package/runtime inputs used for comparison.

Promote saved observations into permanent outcome-based regressions as implementation reaches each boundary: decoded strings, Unicode/malformed URLs, locale extensions and duplicates, malformed LSP bytes/envelopes and formatting modes. Define independent expected behavior; neither the previous encoder nor a new library is the sole oracle.

Freeze the contracts needed by the next packet only:

- Which JSON fields, ordering, numeric spellings and output layouts require byte equality; which consumers need semantic equality instead.
- Supported request identifiers, absent versus explicit-null IDs, duplicate members, integer accessor rules, depth and body limits.
- Ordinary URL values versus trusted origin policy; locale admission versus canonicalization and data aliases.
- File replacement modes, symlink/hardlink behavior and supported hosts; distinguish atomic replacement from crash durability.
- The original `.can` coordinate convention required by actual source-map consumers.

**Deliverable and exit:** a finite packet list with exact writers, acceptance witnesses and a classified compatibility matrix. An unresolved boundary blocks its dependent packet, not unrelated work. Consequential new policy alternatives use verified-context JEV consultation under AGENTS.md; existing broad-strategy advice is split and selects no individual API.

## Pass 1 Remove redundant source string decoding

**Completed within the released source/string contract, 2026-10-07:** see the [Pass 1 implementation and verification receipt](pass1/README.md), including runtime scope and remaining host/linkage gaps.

**Delegation reminder:** Sol low for IR; Sol medium for analysis and review. Follow the [researched task allocation](model-allocation-20261007.md#pass-1) and justify escalation.

**Priority and effort:** immediate correctness repair; small to medium depending on caller coverage. Requires only the relevant Pass 0 source/string contract.

Make IR lowering consume the CST's lexer-owned decoded token value. Reuse it in applicable analysis paths instead of reconstructing JSON string bodies. Trace every secondary decoder caller before deletion; keep source-aware lexing and its diagnostics.

Primary owners: `compiler/src/codegen/ir.rs`, applicable paths in `analysis/types.rs`, and focused codegen/syntax tests. Preserve expression evaluation, literal/default/metadata routes, descriptions and diagnostics. This repair does not depend on Serde, a new JS AST or a grammar change.

Cover backspace, form feed, quotes, slashes/backslashes, BMP Unicode and supplementary characters represented by surrogate pairs. Include both direct literal emission and another live consumer such as defaults or metadata. Invalid source escapes must still produce source diagnostics with the intended spans.

**Deliverable and exit:** decoded source values survive token → IR → emitted JavaScript unchanged. Execute a minimal emitted fixture through the established compiler/testkit seam when that seam can qualify the relevant output; a manually complete synthetic emission result remains narrower evidence. Remove redundant decoders only after their live callers are accounted for.

## Pass 2 Repair LSP byte and envelope admission

**Delegation reminder:** Sol medium for admission; high for unresolved protocol decisions. Follow the [researched task allocation](model-allocation-20261007.md#pass-2) and justify escalation.

**Priority and effort:** immediate authoring-tool correctness; small to medium. Can run independently of Pass 1 and the JSON library migration.

Decode framed message bodies strictly instead of replacing invalid UTF-8. Validate the supported JSON-RPC/LSP envelope: version, method and parameter shapes, legal identifier kinds, and absent versus explicit-null identifiers. Preserve exact spelling for legally supported IDs where the contract requires it; do not preserve acceptance of invalid boolean/object/array IDs as compatibility.

Primary owners: `compiler/src/lsp/server.rs`, `lsp/transport.rs` and real-process authoring/CLI tests. The current JSON parser may remain while admission is corrected. Settle the actual LSP identifier policy rather than deriving it from a library's default integer type or generic JSON-RPC allowance.

Exercise malformed UTF-8, wrong protocol version, malformed parameters, illegal IDs, absent IDs, explicit null and supported numeric/string IDs. Verify the appropriate response/error/no-response distinctions as well as initialization, shutdown, exit and disconnect behavior. Keep the existing body bound and classify other framing requirements before changing them.

**Deliverable and exit:** malformed bytes and envelopes cannot successfully initialize the real server, legal requests retain their obligated identifiers and lifecycle, and failures use the intended protocol/tool error mapping. Typed LSP output and framework transport are later packets.

## Pass 3 Qualify URL and locale admission

**Delegation reminder:** Sol medium for URL/locale qualification; high for owner-policy conflicts. Follow the [researched task allocation](model-allocation-20261007.md#pass-3) and justify escalation.

**Priority and effort:** high correctness priority; medium. Its URL and locale subpackets share `analysis/types.rs` and need one writer or sequential releases.

Replace handwritten URL authority/scheme parsing with a qualified `url` adapter. Include the three-emoji panic, malformed bracketed hosts, excessive ports, credentials, Unicode hosts, backslashes, whitespace, relative inputs and scheme case. Keep ordinary HTTP(S) value policy distinct from trusted `app_url` origins and retain authored values unless an owning contract requires canonicalization.

Replace the interchangeable-locale-subtag heuristic only after a candidate covers the owning runtime's profile. Evaluate full `icu_locale_core::Locale` rather than assuming a language-only parser covers extensions. Include `en-u-ca-gregory`, `en-x-private`, duplicate region/variant cases, canonical duplicates, case and relevant aliases.

Use actual `@canlang/values` exports for differential admission/canonicalization where supported. Primitive `new URL`/`Intl` comparisons remain useful lower-level evidence, but they do not qualify the complete package API or its errors. Keep stable compiler codes and source anchors.

**Deliverable and exit:** supported literals agree with the owning value policy, invalid Unicode inputs diagnose rather than panic, and the selected parser's dependency/profile is qualified. A failed locale candidate does not block the independently completed URL packet. If URL qualification requires longer work, a narrow panic repair may land first; do not build another full handwritten authority parser as an interim solution.

## Pass 4 Replace hashing and temporary-file ownership

**Delegation reminder:** Sol low for hashing; Sol medium for files. Follow the [researched task allocation](model-allocation-20261007.md#pass-4) and justify escalation.

**Priority and effort:** formatting permissions are urgent; hashing is a small maintenance improvement. Both packets can start after their own Pass 0 contract without waiting for Passes 1–3 to finish.

**Hash packet:** retain `sha256_hex` as the stable adapter and use `sha2` internally. Preserve byte inputs, lowercase hex, known-answer/padding-boundary vectors and source/reference/migration/stale-fix consumers. No observed hash defect is claimed. Compare the dependency/features and representative release footprint before accepting the substitution.

**File packet:** replace predictable path-based temp allocation with destination-local owned temporary files. Preserve promised source permissions, including the reproduced `0600` case. Apply the selected symlink/hardlink and destination policy deliberately, preserve error mappings for fmt/docs callers, and qualify cleanup/failure behavior.

Primary owners: `source.rs` for hashing; `cli.rs` for writes; one `compiler/Cargo.toml`/`Cargo.lock` integrator for each reviewed dependency change. Test existing and missing destinations, failure before replacement and the selected supported-host behavior. Do not claim ownership/ACL/crash-durability preservation from a mode test or a successful rename.

**Deliverable and exit:** hashes stay identical and required write semantics hold on each claimed host. There is one hash implementation and one temporary-file ownership path for the changed callers. The two packets have separate acceptance; hash work must not delay the permission repair.

## Pass 5 Migrate typed JSON output

**Delegation reminder:** Sol low for released diagnostic/docs conversions; medium for other serializer families. Follow the [researched task allocation](model-allocation-20261007.md#pass-5) and justify escalation.

**Priority and effort:** next standardization step; medium to high across all serializer consumers. Release it in small serializer-family changes.

Introduce typed Serde output adapters without simultaneously replacing input parsing. Convert diagnostics first to establish explicit field naming, ordering, optional-field and error conventions. Then convert compile artifacts and descriptor metadata, references/docs, policy/explain/fix output and remaining shared JSON string emission as separate packets.

Keep Can's exact wire policy: integers, decimals, durations and money minor units retain their decimal-string representations; authored decimal scale survives. Distinguish omitted values from explicit null and prevent double serialization of pre-rendered fragments. Use typed values or qualified raw-value adapters, rather than another large set of manually assembled strings.

Primary owners include `diagnostic.rs`, `codegen/artifact.rs`, serializer portions of `codegen/js.rs`, `codegen/bdd.rs`, `docs.rs`, `policy.rs`, `explain.rs`, `lint/driver.rs` fix output and the shared JSON module. Account explicitly for CLI fix JSON and generated BDD consumers. These are multiple writer packets, not authority for one worker to edit every owner at once. Coordinate cross-family helpers through the common writer.

**Deliverable and exit per family:** required byte/semantic fixtures and the real consuming path pass, including omissions, controls, ordering, pretty layout and newlines. JS expressions/identifiers and HTML embedding remain their own concerns. Retire a helper when its consumers have migrated, not merely because a replacement exists. The first shared serialization release can unblock later work before every family is complete.

## Pass 6 Replace the JSON input engine

**Delegation reminder:** Sol high for shared input compatibility; split routine helpers into cheaper tasks. Follow the [researched task allocation](model-allocation-20261007.md#pass-6) and justify escalation.

**Priority and effort:** substantial compatibility work; medium to high. Prefer this after a minimal Pass 5 release establishes the shared representations and adapters.

Replace handwritten JSON grammar processing for catalog/LSP inputs under the explicit Pass 0 admission contract. Avoid a blanket conversion to `serde_json::Value`: insertion order, duplicate-member handling, first-match behavior where retained, raw numeric spellings and lexical integer admission must be handled deliberately. Correct malformed behavior separately from required representation fidelity.

Use library parsing with narrow compatibility views/raw values only where callers require them. Preserve strict byte admission, diagnostics/error anchoring, unknown-field behavior and depth/body budgets. Ensure protection operates while input is being parsed; merely inspecting an unbounded completed tree is insufficient.

Primary owners: `json.rs`, catalog loader adapters and affected LSP callers. Reuse Pass 2's framed-process witnesses. Cover trailing input, JSON numeric grammar, Unicode/surrogate errors, duplicate keys, supported ID boundaries and depth boundary cases. Error-message differences need explicit compatibility classification rather than blanket equality or silent drift.

**Deliverable and exit:** actual catalog and LSP consumers accept/reject and report correctly, required lexemes and ordering survive, and the handwritten parser can be retired. A small caller compatibility representation may remain. If preserving requirements produces another full parser or excessively complicated adapter, compare that cost with retaining the proven bounded representation before committing to removal.

## Pass 7 Adopt typed LSP output and consolidate URI handling

**Delegation reminder:** Sol medium for DTO/URI adapters; high for cross-owner conflicts. Follow the [researched task allocation](model-allocation-20261007.md#pass-7) and justify escalation.

**Priority and effort:** medium, after Pass 2 admission and the relevant Pass 5 serialization seam. It does not need every Pass 6 input caller to be migrated.

Use `lsp-types` for capabilities, positions/ranges, enum values, diagnostics, symbols, rename edits and code actions. Carry the appropriate document version in edits, including null only where the supported identifier contract calls for it. Preserve current snapshots, negotiated positions, stale-result handling and initialization/shutdown.

Once Pass 3's URL dependency/contract is released, qualify the document URI adapter in this same writer packet or a serialized follow-up. Preserve non-file identities; distinguish file authority, display paths and actual filesystem conversion. Share position conversion through the existing source owner rather than introducing a second index policy.

Primary owners: `lsp/server.rs`, associated adapters, IDE/source conversion where needed and real editor/process tests. Input representation and transport remain separable from output DTO construction.

**Deliverable and exit:** a real framed session covers diagnostics and edits, current document versions and Unicode/CRLF positions, as well as existing lifecycle negatives. Keep the current transport unless a separately qualified framework is simpler and preserves IDs, bounds, framing and termination. `lsp-server` adoption is conditional, not a required completion item.

## Pass 8 Qualify source-map coordinates and replace the codec

**Delegation reminder:** Sol medium for the released byte-profile codec; high for coordinate-policy conflicts. Follow the [researched task allocation](model-allocation-20261007.md#pass-8) and justify escalation.

**Priority and effort:** medium, with a consumer decision before implementation. Can overlap other serialization work once its exact writer and coordinate contract are released.

Resolve the original `.can` column convention using the actual source-map consumers. The observed byte-6 versus UTF16-3 result for `é😀x` is evidence of different units; it is not already proof of browser misnavigation. Fix any demonstrated consumer mismatch in the Can span adapter.

Replace standard VLQ/map encoding with `sourcemap`, retaining source/name order, source contents, mapping attribution and artifact shape. Explicitly translate library-assigned source/name IDs; registration may deduplicate them. Preserve generated-coordinate behavior and meaningful unmapped cases.

Primary owners: `codegen/sourcemap.rs`, the affected artifact serialization seam and source-map consumers/fixtures. Compare using an independent decoder and the actual consumer, with non-ASCII, CRLF, several sources, repeated names and empty/unmapped mappings. A round trip through the same new encoder and decoder is not independent acceptance.

**Deliverable and exit:** the consuming tool resolves representative locations correctly, the artifact retains required fields/order and the handwritten codec is retired. If the consumer convention is unresolved, keep this packet blocked explicitly; unrelated compiler repairs can still release.

## Pass 9 Evaluate the remaining mechanisms separately

**Delegation reminder:** Use the candidate-specific low/medium/high allocation; release a bounded packet first. Follow the [researched task allocation](model-allocation-20261007.md#pass-9) and justify escalation.

**Priority and effort:** conditional packets with their own benefit and preservation criteria. No requirement to finish all of them before releasing the earlier improvements.

| Candidate | Required comparison | Adoption gate |
| --- | --- | --- |
| CLI grammar/completions | `clap`/`clap_complete` versus current metadata; include help precedence, duplicate flags, `--`, exact platform passthrough and error/exit conventions | Consolidation reduces duplicate metadata while real command/completion behavior remains compatible; framework defaults do not choose the CLI contract |
| ICU syntax | First execute owner/compiler parity for ordinary/integer number and cardinal/ordinal types; then compare FormatJS parse-core with the bounded Can scanner | Keep allowed grammar/styles, exact selectors, duplicate handling, quoting, depth 32, parameter/disclosure checks and diagnostics. Parser recursion protection must be sufficient before tree validation |
| Temporal mechanisms | Compare owner-derived date/datetime vectors with a bounded library/shared-core proposal | Preserve years, spelling, zones, leap-second/sub-millisecond rules and post-offset range; direct private values-core linkage still needs the L-F03 boundary release |
| Graph algorithms | Shared iterative routine versus `petgraph` SCCs on representative graphs and invariant witnesses | Preserve edge scopes, diagnostic multiplicity/order, witness paths and upstream chains reaching a cycle; source reduction and algorithmic complexity alone are not measured workload benefit |
| Positions and lexical paths | Existing shared index/normalization versus a small library adapter | Preserve byte spans, CRLF/clamping and path identity; avoid a second conflicting policy or a dependency that costs more adapter code than it removes |

If executed ICU or other comparisons expose a new concrete policy defect, promote the bounded repair to the correctness queue without waiting for the entire candidate evaluation. Retaining a small custom mechanism is an acceptable reviewed result where the library adapter is not simpler.

Rowan, Salsa and a JS AST/printer migration are separate architectural projects. Reuse existing parse/resolution results and measure editor workloads first; preserve syntax recovery, catalog invalidation, evaluation order and source attribution. The utility programme does not require these projects.

## Pass 10 Qualify the final compiler and retire obsolete paths

**Qualified at the selected compiler scope, 2026-10-07:** [final evidence and independent review](pass10/README.md) record 1,048 passing tests, required fmt/all-target Clippy/public recipes, matched native/Linux release footprints, actual current/fresh-installed consumers, predecessor retirement and explicit unresolved product/policy boundaries. No merge or living checkpoint advancement occurred.

**Delegation reminder:** Luna low/medium for checks and receipts; Sol medium for substantive review. Follow the [researched task allocation](model-allocation-20261007.md#pass-10) and justify escalation.

**Priority and effort:** required completion of the selected core substitutions, with consumer scope matched to the changed boundaries.

Run the compiler's applicable unit/integration suites and full required compiler checks on the final dependency graph: `cargo test --locked`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, plus the release build and relevant public task-runner recipes. Preserve actual commands, source/catalog/toolchain hashes and results.

Exercise actual CLI/LSP/artifact consumers, independently authored behavior and selected emitted-code execution. Qualify the changed output through the installed-package/original-app path where its owners have released the required inputs. Relevant unresolved product prerequisites remain visible; a compiler utility test does not complete T37 or the installed-release parent. Conversely, unrelated unfinished product families do not block a qualified compiler repair.

Compare release footprint/build behavior at equivalent toolchain/profile/workload inputs. Pin adopted crate versions/features and required release closure. Search for remaining handwritten parser/hash/codec/escape paths, orphan helpers and unused dependencies; remove them only after accounting for their real consumers. Avoid dual implementations that become permanent fallback engines.

**Deliverable and exit:** selected core packets have independently reviewed evidence, retired predecessors and a supported compiler release at their declared scope. Conditional mechanisms have explicit adopt/retain/defer results. Update README/decisions/task references; after an actual merge, reconcile all accumulated living-plan changes and advance its checkpoint only when the required complete review is done.

## Actual scheduling and writer ownership

The numbering explains priority and dependency; it is not a global sequence in which every worker waits for the previous whole pass.

| Work | Earliest released input | Parallelism and conflict |
| --- | --- | --- |
| String repair | Pass 0 string witnesses | Release the `ir.rs` subpacket separately; serialize analysis decoder changes with the URL/locale/temporal `types.rs` writer. Reserve codegen edits against FP.COMPILED-DECIMAL/FP.CONTEXT and shared tests |
| LSP admission | Pass 0 envelope/ID policy | May run alongside string/validators; serialize later server/transport edits |
| URL and locale | Pass 0 owner vectors | One `types.rs` writer; investigation/vectors can be prepared separately; temporal work later shares this file |
| Tempfiles | Pass 0 file policy | Can proceed immediately alongside other repairs; later CLI migration shares `cli.rs` |
| SHA2 | Pass 0 hash contract | Independent of correctness branches; shares `source.rs` with position consolidation |
| Output serializers | Per-family output contract | Separate files may progress together; one writer coordinates shared escaping/types and assembly |
| Input parser | Admission contract plus released shared representation | Serialize `json.rs`/catalog joins; LSP DTO work can progress independently on released interfaces |
| LSP DTOs/URIs | Admission repair + shared serialization; qualified URL seam for URI work | One `server.rs` writer; no mandatory transport-framework join |
| Source maps | Released coordinate contract and artifact interface | Independent codec writer; serialize artifact/test fixture overlap |
| Optional mechanisms | Their own supplied contracts and demonstrated benefit | Not prerequisites for the core utility release |

One compiler dependency integrator owns `compiler/Cargo.toml` and `compiler/Cargo.lock`; add each reviewed dependency with its packet. One writer owns each shared file/test fixture at a time. Independent fixtures, caller inspection and reviews can overlap even when implementation edits must serialize. Maintain a useful ready queue rather than borrowing package Rust workers without a scope change.

## Economical Codex delegation and commit cadence

**USER / accepted operating policy, 2026-10-06:** dispatch compiler packets to Codex subagents with the least expensive supported model and reasoning effort likely to complete them reliably. The root owns assignment, invariant review and Git integration. Keep delegated context focused on the packet's contracts, defining files and raw evidence; do not fork the full conversation by default.

| Packet type | Starting model and reasoning | Examples and limits |
| --- | --- | --- |
| Clear single-step bookkeeping | `gpt-6-luna`, `low` | Inventory, link checks, caller enumeration and receipt summaries; no independent semantic policy choice |
| Bounded work with established expected behavior | `gpt-6-luna`, `medium` | Prepare regression vectors, perform repeated conversions under an already released schema, or check plan/commit scope |
| Narrow technical implementation | `gpt-6.1-sol`, `low` | One-owner string-payload or hash-adapter change with known contracts and focused checks |
| Implementation or review requiring technical judgment | `gpt-6.1-sol`, `medium` | LSP admission, file replacement, URL/locale adapters, JSON input representation and substantive independent review |
| Unresolved cross-file semantics or consequential alternatives | `gpt-6.1-sol`, `high`, only with a recorded reason | Escalate the affected packet for actual ambiguity or failure; do not raise every worker because the overall programme is large |

[Task-specific allocation, researched 2026-10-07](model-allocation-20261007.md), refines this general table for all 16 Pass 0 packets, optional comparisons and final qualification. It records official model/reasoning guidance, supported dispatcher settings, Codex credit rates separately from API prices, and concrete escalation triggers. These are proposed starting settings inferred from the task contracts; no source or experiment establishes a measured optimum for this compiler. In particular, C06 starts at Sol high for already identified cross-caller compatibility work.

Current model availability comes from the dispatcher. The [official selection guide](https://developers.openai.com/api/docs/guides/model-selection) and [Codex models guidance](https://learn.chatgpt.com/docs/models) inform the allocation; verify choices on actual released packets. Account for context, retries, review and available usage data. Do not estimate included subscription usage from API prices or claim programme savings before execution.

Use no more than the available worker slots and assign only released, disjoint writers. A useful first implementation dispatch is a narrow Sol string-repair packet, a bounded LSP packet and a Luna regression/contract packet; rotate work as results arrive. The root handles shared dependency joins and can retain file-policy decisions until their prerequisites are ready. Implementers do not own their acceptance verdict.

Commit early and often at coherent, checked boundaries. Save the audit/planning baseline now; during implementation, commit a focused regression-and-repair packet once its appropriate checks and review pass. Give independently accepted hash/file changes and each serializer family separate commits instead of waiting for the whole numbered pass. Commit subsequent corrections separately. Keep intentional red reproduction evidence in clearly labeled audit artifacts rather than leaving the ordinary test suite failing in a released commit.

The root stages only the packet's changes, including the matching decision/evidence updates; preserve unrelated working changes. Use Conventional Commit messages and record the resulting commit in the packet receipt. Root-controlled integration prevents competing Git mutations; commits do not imply a merge, publication, product acceptance or checkpoint advancement.

## Connection to the existing plans

Keep one bounded compiler remediation ledger alongside this audit, with links from the existing remaining-work and finished-product task map when this proposal is adopted for dispatch. Add newly discovered defects explicitly; historical accepted T35/A3 packets did not prove them covered. Preserve those earlier statuses and acceptance.

T15 supplies affected descriptor compatibility; T37/FP.QUALIFY and FP.INSTALLED-RELEASE supply matching real consumer acceptance. String repair overlaps FP.COMPILED-DECIMAL/FP.CONTEXT defining files, without completing their distinct contracts. Source closure and final review account for newly changed duties. Cross-reference actual consumer dependencies instead of making every library substitution a prerequisite for every product task.

The [package Rust-port execution plan](../../../implementation/RUST-PORT-EXECUTION-PLAN.md) explicitly excludes compiler changes. Preserve its 230 identities, R1–R4 allocation, native preparation HOLD and private values-core boundaries. No new master migration, deployment topology or language syntax is selected by this sequence.

The original planning round changed no compiler/runtime source, manifests, dependencies, canonical task statuses or living checkpoint. It reran no product checks to produce the sequence; preparation consisted of source/plan reads and independent sequencing challenge, followed by local link, baseline and documentation checks. Later implementation and qualification are recorded in the linked receipts, without rewriting that historical evidence or completing unrelated product tasks.
