# Pass 0 contracts and regression witnesses

**Preparation complete at its bounded scope, 2026-10-07.** This packet produces a finite implementation queue, explicit writers, classified contracts and durable outcome witnesses. It fixes no compiler error and qualifies no candidate Rust library. Ready contracts can proceed; identified gates apply only to their dependent work.

The compiler build revision is `38c0370087909dc89386849fec48e6f937aa0d13`. All 81 compiler files retain the original audit hashes at `309644a6881909d8dba32560bc6711f67e00a7ab`. [Host/build profile](evidence/root/profile.json) records a fresh locked lib+binary build on macOS 27.0.1 / arm64 with Rust/Cargo 1.99.0, Node 24.21.0 / ICU 78.3 and Bun 1.4.2. The binary reports commit `38c0370`, language `1.0`, schema `1`. The separately recorded evidence-capture revision includes subsequent concurrent documentation commits; it is not the binary's build revision. These exact observations do not qualify another host.

[Input manifest](evidence/root/input-manifest.json) pins 541 compiler/package/consumer/tool/specification/witness files, conservatively including tracked values/contracts and their existing built outputs. Executed root probe sources and witness bytes are hashed in the profile as well. The actual producer catalog is `packages/values/dist/catalog.json`, language `1.0`, catalog `0.1.0-lane02-draft`, SHA-256 `cd984f375e0d6cbcc2bc6aca5ad5ea5b1b3d3ba9cd17b15ab94e4b15e74ced62`. The string emission probe uses its separately disclosed empty synthetic versioned catalog; it does not establish real-catalog CLI readiness. Package versions are `0.1.0`; exact bytes and public export resolution matter more than that shared version alone.

The existing [release workflow](../../../../.github/workflows/release.yml) names Linux x86_64 and macOS aarch64 compiler artifacts and pins Rust 1.99.0. Preserve these required profiles during adoption. Linux behavior, release footprint and installed artifacts were not executed here. There is no newly selected Windows support claim.

## Finite packet queue and exact writers

These local labels identify work, not historical task completion. Writer names designate exclusive ownership roles, not launched workers. [Machine-readable packet ledger](packets.json) records dependencies, files and acceptance. Root owns dependency/Git integration; candidate versions and final feature closures must be pinned with the actual implementation packet.

| Packet | Exclusive writer and defining files | Contract readiness and next release |
| --- | --- | --- |
| C01IR — decoded lowering | `ir`; `compiler/src/codegen/ir.rs`, focused `tests/codegen.rs` fixtures | Ready. Consume existing token payload in direct literals and metadata helpers; no dependency. Reserve against FP.COMPILED-DECIMAL/FP.CONTEXT writers. |
| C01A — decoded analysis | `types`; `analysis/types.rs`, relevant analysis/syntax fixtures | Ready for caller-preserving consolidation after payload availability checks. Same writer as C03U/C03L; correct current analysis decoder is not a demonstrated valid-input bug. |
| C02 — LSP admission | `lsp`; `lsp/server.rs`, `lsp/transport.rs`, process fixtures | Ready invariants plus named response/parameter/framing gates. Keep the parser/transport for a bounded admission repair. |
| C03U — ordinary URL admission | `types`; `analysis/types.rs`, scalar literal/argument fixtures | Owner contract ready; Rust parser/features and supported-host parity need qualification. Separate trusted-origin policy. |
| C03L — locale admission/identity | `types`; same defining file and message/context/source fixtures | Owner witnesses ready; complete parser/alias/canonical identity qualification gated. Independent URL release need not wait. |
| C04H — hash adapter | `source`; `source.rs`, foundation/stale-fix/reference/migration fixtures | Ready unchanged byte/hash contract; `sha2` feature/footprint qualification remains implementation work. |
| C04F — file ownership | `cli`; `cli.rs`, authoring/docs/exe fixtures | Ready regular-source mode/no-op/order invariants. Full temporary-file cutover gated on link/new-output/metadata policy and Linux evidence. |
| C05D — diagnostic JSON | `diagnostic`; `diagnostic.rs`, foundation/CLI fixtures | Field/key order, compactness, source bytes, sorting/completeness fixed. Establish exact baseline bytes and classify any escape spelling changes before cutover. |
| C05Other — remaining output families | Per-family artifact/JS-BDD/docs/policy/explain/lint writer | Exact value and artifact schema ownership fixed; per-family byte/semantic snapshots and omissions must be released before assigning that serializer. |
| C06 — JSON input | `json`; `json.rs`, catalog adapter and shared LSP joins | Numeric representation/accessor and parser-budget evidence ready. Duplicate/depth-edge/error/catalog policies gated. Requires released representation seam from C05. |
| C07DTO / C07URI — editor outputs | `lsp`; server DTO/URI adapters and version/position fixtures | Versioned edits and UTF-16 position ownership established. Actual typed/URI consumer qualification follows C02/C05 and qualified URL seam. Framework transport remains conditional. |
| C08 — source-map codec | `map`; `codegen/sourcemap.rs`, artifact interface and independent consumer fixtures | Existing Can byte-coordinate profile ready to preserve. Changing original columns for browser/editor navigation remains gated on that consumer's contract. |

The ledger contains **16 implementation packets**. C09 remains a deferred comparison list outside that queue: optional CLI/ICU/temporal/graph/source work requires its own exact owner/files/caller/acceptance packet before dispatch. It is not a prerequisite for these releases.

Commit the first checked C01IR repair independently. C02 contract decisions, C03U qualification and regular-file regressions can be prepared concurrently with disjoint writers. One manifest/lock integrator joins newly qualified dependencies. Shared test files are reserved just like product files; fixtures/review preparation can overlap outside those reservations.

## Caller closure and owning declarations

[Direct helper-use inventory](evidence/root/caller-sites.json) includes function-pointer consumers, not just `name(...)` calls. It is a source-inspection aid, not a complete inferred call graph. Packet boundaries below account for the live routes; new callers found during implementation expand that packet's coverage before helper deletion.

**C01IR:** lexer `decode_json_string:691` stores `Token::string_value`; CST `NodeDetail::Token` retains it. IR `decode_literal:2363` and `literal_string_opt:2610` currently call `decode_string`. The metadata helper reaches message source/variants, explicit format locale, page title/caption, `opens=` and static text (`decode_message_node`, `decode_variant`, `decode_format_call`, `decode_page`, `decode_caption_header`, `opens_spelling`, `static_text`). `analysis/examples.rs::literal_string:2896` demonstrates owning-payload reuse. Retain recovery/error behavior; empty authored strings differ from missing decoded payload. No global lexer/parser/JS printer replacement is needed.

**C01A:** eight `unescape_json` uses include schedule keys, generic/bare string helpers, contextual literal typing, local instant input, format locale, checked constructors and overload inhabitation. Those helpers feed captions/descriptions, module source tags, context locale, static page text and fixture values. The analysis decoder currently handles surrogate pairs correctly. Preserve values, schedule-key identity, classification and error spans; serialize this ownership cleanup with validator edits.

**C02/C06:** [protocol contracts](protocol-contracts.md) trace shared JSON accessors/rendering, producer catalog loading, framed stdio, lifecycle, real IDE analysis and VS Code/process consumers. LSP is narrower than generic JSON-RPC. The detailed matrix separates standard requirements, current extensions and new policy questions.

**C03U/C03L:** [value contracts](value-contracts.md) trace contextual literal/overload paths and direct message/context/source checks to actual exported values APIs, language declarations and owner tests. Compiler E3001 versus message E3016 categories stay distinct. Canonical aliases cannot be inferred from lowercase spelling.

**C04H:** `SourceDb::add:44` owns immutable source hashes; public `sha256_hex:187` also feeds docs `source_revision:961`, IDE `apply_fix:137`, LSP `diagnostic_fix_to_action:502` and IR `build_migrations:5033`. Hash input is exact UTF-8 bytes, including CRLF. Preserve lowercase 64-digit output and stale-fix comparison semantics. Source identity and revision framing remain Can-owned.

**C04F:** `write_file_atomic:1344` has exactly two production callers: `run_docs_with_platform:954` and `run_fmt:1328`. Fmt reads/formats all operands before any write, skips equal bytes and writes changed files in operand order; an IO failure can leave earlier files rewritten. Both write failures map E7007; input read failures map E7002. Docs refuses authored `.can`/input overwrites before rendering. Same-directory rename is per-file atomic replacement, not an all-operands transaction or durability proof.

**C05:** diagnostics belong to `diagnostic.rs` / `packages/contracts/src/diagnostic.ts` and reach CLI check/lint/fmt plus editor conversion. Artifacts belong to `codegen/artifact.rs` / contracts `artifact.ts` and actual Cloudflare/testkit loaders. `codegen/js.rs` owns descriptor output and exact `literal_json`; `codegen/bdd.rs` owns generated-test strings. Docs constructs shared `Json` output consumed by platform docs. Policy/explain output and `lint/driver.rs::{fix_to_json,fixes_to_json,rejected_to_json}` have their own CLI consumers. JS expression printing and HTML embedding are separate from JSON transport.

**C08:** artifact assembly calls `sourcemap::build` for entry/package/test modules; artifact JSON embeds maps. `source.rs::LineIndex::line_col` explicitly counts original bytes; contracts `artifact.ts` describes `.can` byte-span resolution. Actual runtime `sourcemap.ts::lookup` returns supplied original columns plus one; `invoke.ts:280` subtracts one from generated stack columns before lookup and separately accepts already remapped frames. [Fresh compiler map → independent Node decoder → actual internal consumer](evidence/root/map-results.json) confirms original column 6 becomes Can column 7 for the authored `é😀x` fixture. This establishes the current byte-profile relationship, not browser cursor correctness or installed artifact assembly.

## Classified compatibility matrix

“Preserve” is an established contract; “correct” is known wrong behavior; “gate” requires a bounded decision or candidate qualification. Ready witnesses do not imply their implementation already passes.

| Boundary | Classification and frozen expectation | Witness / remaining gate |
| --- | --- | --- |
| Source strings | Correct IR escape corruption; preserve lexer-owned Unicode scalar values, invalid-source diagnostics, spans and evaluation order | [8 string vectors](witnesses/strings.json); fresh emission probe still corrupts controls/pair. Add literal and metadata product tests with C01. |
| Ordinary URLs | Correct panic/malformed host/port and stricter-than-owner admission; preserve decoded authored text after supported HTTP(S) admission | [Values vectors](witnesses/values.json), actual public exports. Rust candidate parity is not yet proved. |
| Trusted origins | Preserve separately stricter credential/query/fragment and safe-path policy | Actual `app_url` observations. Do not apply ordinary-value permissiveness to origin authority. |
| Locales | Correct extension/private/duplicate admission; owner canonicalizes scalar wire and variant keys | Public exports match vectors. Compile-time alias/data/canonical identity and candidate scope remain gated. |
| Hashes | Byte equality: exact input and lowercase SHA-256 output, with identity/stale-fix consumers intact | 9 independent hashlib comparisons. No current hash defect claimed. |
| Files | Correct regular-source mode widening; preserve no-op, parse-before-write, operand/error order and destination-local staging | 4 local process observations. Link/new-output/metadata/race/Linux policy gates remain explicit. No sync guarantee selected. |
| Diagnostic JSON | Byte requirements: fixed key order, compact single-line envelope and CLI newline. Preserve sorted diagnostics, canonical source offsets, all required fields and disclosed incompleteness/omission | Contract `diagnostic.ts:62`, foundation/CLI acceptance and independent JSON parse of control/Unicode probe. Exact escaping baseline needs explicit per-packet preservation or reviewed representation change. |
| Artifact/descriptor JSON | Schema/value equality with deterministic arrays/identities and authored JS/content; numeric strings must never become binary JSON numbers | Existing artifact contracts and B1/T15 consumer gates. Per-family output byte goldens/optional-null classifications remain preparation at that writer release. |
| Exact scalar transport | Preserve authored decimal scale into value construction; runtime encoding may normalize trailing zeros. Integer/duration/money components retain decimal strings | Public int64/large-decimal/duration/money observations. Full arithmetic/context lowering remains its original separate duty. |
| Policy/docs/explain/fix output | Preserve source-order and raw source facts, stable identifiers, omissions and documented layout/newlines; do not extrapolate diagnostic schema onto every family | Defining serializer/CLI owners; finite per-family snapshot gate before cutover. |
| LSP bytes/IDs/envelopes | Correct malformed admission; preserve legal signed-32-bit/string IDs, notification distinction, current supported sync/positions and body cap | [44 protocol vectors](witnesses/lsp.json): ready and gated outcomes are separately labeled. Mapping/order/parameter decisions stay gated. |
| JSON input representation | Preserve raw lexemes, lexical integer accessor and required ordered compatibility views; preserve bounded parsing while processing | Duplicate and empty-container depth edges are explicit gates. A last-wins Value map is not accepted silently. |
| Original source-map columns | Preserve current `.can` byte-column profile for the established runtime path; generated maps/consumer coordinates retain their current contract | Independent decoder and internal lookup agree; browser/editor coordinate change is a separate gated witness. |

## Candidate dependencies and features

No version/feature is approved by this preparation. The following intended API surfaces bound subsequent qualification; exact selected versions, MSRV/features, release size and supported-host closure belong in the implementation receipt.

| Packet | Candidate profile to qualify |
| --- | --- |
| C01/C02 initial repair | Existing lexer/CST and current transport; no new dependency required |
| C03U / C07URI | `url::Url` parsing and separately file-URI conversion. Serialization integration is unnecessary for literal admission; avoid optional features without a caller. |
| C03L | Full `icu_locale_core::Locale`; a language-only identifier is insufficient. Parsing versus alias/data canonicalization must be accounted for explicitly. |
| C04H | `sha2::Sha256` / `Digest` behind stable `sha256_hex`; optional acceleration/profile selection awaits equivalent release measurements. |
| C04F | `tempfile::NamedTempFile::new_in` / replacement persistence with explicit Can permissions/link/error policy; metadata and sync behavior are not delegated by implication. |
| C05 | `serde` typed serializers with `derive` where useful; `serde_json` string/value output. `raw_value` only for callers requiring validated encoded fragments. |
| C06 | `serde_json` parsing; evaluate `raw_value` and an ordered compatibility representation. `preserve_order` does not preserve duplicate members. Budgets must hold during parsing. |
| C07DTO | `lsp-types` DTO/enum/URI representations compatible with chosen Serde seam; keep version/lifecycle/source-policy ownership. `lsp-server` is not selected. |
| C08 | `sourcemap` codec/builder/decoder; map source/name IDs explicitly and preserve the released coordinate/artifact contract. |

## Witness integration and acceptance

Witness files are permanent repository preparation artifacts, not dormant production tests or a red ordinary suite. Each carries input, expected result, current observation and readiness, with its independent oracle explicit on the case or inherited from the fixture. When its boundary is implemented, the defining writer imports or translates the ready cases into the existing owning tests and records coverage. A gated expected response is a proposal, never an accepted assertion. Track the remaining vector-to-product-test transfer in that packet receipt.

Executed here: fresh locked compiler build; 8 lexer/independent string cases; 9 hash comparisons; 28 current public values API cases plus 4 exact wire values; 26 framed LSP sessions and a direct defining-module parser/framing harness; 4 local fmt filesystem observations; independent Node source-map decoding and actual internal lookup; preservation/schema/link checks. [Final verification receipt](verification.json) records counts, provenance and review corrections. Known emission and mode defects remain visible. Prior audit unit/integration totals are historical; no full suite, new Rust candidate, installed tarball, browser or alternate-host parity is claimed.

Root evidence replay, after the declared fresh build:

```sh
python3 docs/research/compiler-library-audit-20261006/pass0/evidence/root/verify.py --binary-dir /private/tmp/canlang-compiler-pass0-38c0370/debug
```

Protocol replay commands and source/binary pins are under [protocol evidence](evidence/protocol/). Root raw commands/results are under [root evidence](evidence/root/). Replays refresh evidence at their actual current inputs; they must not be presented as the original frozen receipt.

## Plan connection and unresolved boundaries

New defects can be linked as newly explicit T35/A3 children; earlier accepted packets do not cover them automatically. C05/descriptor changes retain T15 acceptance; C01 reserves its defining files against FP.COMPILED-DECIMAL/FP.CONTEXT without completing those duties. Relevant installed/original-app behavior retains T37/FP.QUALIFY/FP.INSTALLED-RELEASE scope. C08 compiler codecs are separate from provider-source FP.SOURCE-MAPPINGS. Preserve the compiler exclusion in R1–R4 package port allocation and L-F03's private-core gate.

Unresolved choices are intentionally left local: LSP invalid-envelope/ID/error correlation and parameter strictness; per-caller JSON duplicates/depth/error compatibility; complete locale aliases; filesystem link/new-output/metadata/host behavior; and browser/editor column interpretation. None blocks the ready C01IR packet. Verified-context three-request JEV consultation is required when selecting consequential alternatives; this round selects no such alternative and does not recycle the earlier split broad-strategy advice into policy approval.

Preparation can be committed now. Future checked repairs/serializer families commit independently under the [economical Codex operating policy](../implementation-passes.md#economical-codex-delegation-and-commit-cadence). No compiler/runtime source, manifest, lockfile, canonical status, merge, publication or complete living checkpoint is changed by Pass 0.
