# FAIL-R06: finite width boundaries

The original finite duties are [admission.json](../../../docs/research/compiler-library-audit-20261006/responsibility-map/failure-evidence/admission.json) AR-09/11/17 and the `offset-u32`, `semantic-ids-u32`, `cycle-width`, `icu-wide`, `diagnostic-joining`, and `source-map-growth` entries in [algorithms.json](../../../docs/research/compiler-library-audit-20261006/responsibility-map/failure-evidence/algorithms.json). They are separate responsibilities, not a shared size policy.

`compiler/src/codegen/sourcemap.rs::build` now uses the existing library's returned interned name ID to append new names in first-appearance order. This removes its redundant linear `names.contains` scan for each emitted line. The pinned sourcemap 9.3.2 `SourceMapBuilder::add_name` already owns hash-based lookup and assigns new IDs from its append-only name table. No additional name index or dependency is introduced.

The product regression builds 512 generated rows using 256 distinct names, including the empty name, followed by their reverse-order reuse. It verifies every decoded name/source/line/byte-column coordinate and serialized names, exact Unicode/CRLF source content, and mappings. Existing small map, missing-source, duplicate-path and numeric envelope controls remain unchanged.

Validation: `CARGO_BUILD_JOBS=2 cargo test --manifest-path compiler/Cargo.toml --locked --offline --lib codegen::sourcemap::tests` passed all six checks, including the new wide-name regression.

The standalone JSON-string decoder's tiny `"\q"` input at absolute base
`u32::MAX` reproduced a native debug overflow panic in error-span addition.
It now checks the token's byte length and absolute endpoint before decoding,
using the existing error return with a point span at the supplied base.
Exact-fitting valid and malformed tokens preserve their values, messages and
translated spans. The focused syntax case covers Unicode, unknown escapes,
lone surrogates, malformed Unicode escapes and a tab without large allocation.
This bounded admission keeps the decoder's existing quoted-token precondition.

The new finite source control places checked declarations at byte offsets
255/256 and 65,535/65,536 in genuine UTF-8/CRLF sources, checks lossless parse
coverage and LSP positions, and preserves 257 real immutable source snapshots
across path replacement. It also verifies unknown source-ID refusal. These
controls exercise existing production APIs; they do not execute a source or
source count beyond `u32::MAX` or select a whole-source support limit.

The focused `message_width` case passes 100/1,000/3,000 flat plural/select
choices and distinct declared placeholders through named-message checking,
including source and translated templates and a 512-digit exact selector.
Checked templates, parameter order and types remain exact. A duplicate final
translated branch and an unknown final slot retain their precise diagnostics.
The separate diagnostic-width case passes 100/1,000/3,000 repeated and varied
authored unresolved-name errors through checking and the actual diagnostic
serializer, preserving every message/span in order with no withheld output.
These observations qualify finite inputs, without a performance threshold,
new suppression policy or wider runtime formatter claim.

The focused graph case passes forward chains and sparse stars at
100/1,000/3,000 typed derives, plus a 24-node complete DAG with 276 edges.
Owning module/symbol IDs, parameter/result types and every selected call edge
remain exact. A 100-node star sharing a terminal self-cycle reports exactly
one E2018 at that declaration, without contaminating upstream origins.
Existing fixed cycle policies are reused from `cycle_witness`; no wide runtime
invocation or extreme cardinality guarantee follows from checked source.

## Remaining original obligations

- Source-owner counts/whole-source bytes, standalone line-index/lexer/parser intake and semantic IDs now have explicit representability admission as recorded below. Generated/source-map widths remain separate; no giant allocation or arbitrary resource guarantee follows from finite controls.
- The new permanent `width_boundaries` test qualifies actual loaded builtin matching through 0/16/32/64/128 nullable postfix wrappers: clean int input produces exactly one selected builtin call, and bool input produces E3005. The original loaded Catalog and owning SourceDb remain intact. This does not qualify arbitrary collection/object signature shapes or an extreme supported depth.
- Direct inspection corrected the original field-depth lead: current `decl_type` only reads cached types, and phase1 resolves forward declarations by fixpoint rounds rather than recursive declaration traversal. The permanent valid forward-chain test passed 0/16/32/64/128 reuse links and verified each canonical field resolves to int plus an explicitly typed derive use. The original two-field cycle returned no diagnostics despite the existing E3008 contract. The checker now records canonical field dependencies in the final fixpoint round and uses deterministic iterative strongly connected components to report cyclic reference spans. The ineffective stack guard is retired. Self and mutual cycles refuse; acyclic upstream references and unrelated int fields retain their behavior.
- The new graph, message and diagnostic width controls cover the finite cases above; extreme numeric/output growth remains a separate support obligation. Existing semantic outcomes are reused at their declared scope.
- Generated/source map numeric widths and per-module repeated source contents/output growth remain distinct from the corrected name scan. No supported extreme count, memory bound, timing threshold or public forged-carrier guarantee is established here.

Direct validation used one locked/offline jobs2 `width_boundaries` target: catalog matching passed; the added cycle control failed after the zero-link acyclic case succeeded. After separating that unrelated control, the exact acyclic test passed every finite link count; catalog matching was not repeated. After the source correction, the two affected field-reuse tests passed, including all five forward-chain depths and exact self/mutual cycle messages and spans. The existing `analysis::suffix_bang_and_default_order` test also passed. The unchanged catalog ladder was reused; no full suite was repeated. Numeric refusal or resource/support policy requires a separately selected contract; this change adds no cap or suppression.

## Source intake admission

`58209f7b` selects the intrinsic u32 representation boundary through additive
`SourceDb::try_add`, `LineIndex::try_new` and `admit_source_len`. Exact MAX
byte endpoints and the final MAX identity are representable; rejection precedes
hashing/storage/path mutation. Existing `add`/`new` convenience APIs retain
documented deterministic panic behavior for unrepresentable caller input.
CLI source tools precheck opened-file length before reading and limit stream
or growing-file reads to the first unrepresentable byte; failures use E7002.
LSP source admission failures log through typed `window/logMessage` without
changing the last admitted owner/document/version/queue. Live remapping relies
on previously admitted texts and a no-larger source count.

The [three saved consultations](../source-admission/jev-response-1.json) advise
the additive fallible owner over widening all carriers or distributing checked
preconditions. Confidence is .94/.88/.37; the weakest answer assigns .58 to
fallible owner and .42 to checked precondition, with no rationale. Centralizing
exact admission while retaining ordinary API behavior supports the selected
choice; the replies do not establish universal memory or compatibility claims.

The native sparse MAX+1 file case passes **1/1**, covering actual
check/compile/lint/policy/docs/fmt refusals, empty output and unchanged inputs
without allocating huge source text. An actual ordinary fmt stdin control
retains exact bytes and exits 0. Standalone lexer/parser entrypoints at `41b587fc` use the
same whole-length admission before UTF-8/scanning/layout/parsing; rejection is
E1008 at the source start with empty lines or the existing empty File root.
Actual MAX-sized text and billions of identities were not allocated;
generated output/map growth remains unqualified. This component
does not close the broader FAIL-R06 reference.

Their existing lexer and parser error/span cases each pass **1/1** after
these guards; the final source-matching CLI build passes. The ordinary
source/graph/message/diagnostic controls are reused without a repeat suite.

## Semantic ID admission

`e217deaf` checks the owning vector length before every actual module, symbol
and lexical-scope allocation. IDs through `u32::MAX` are representable;
E2019 refuses the next allocation without truncation. The additive
`try_resolve_program` returns a capacity error instead of partial tables.
The existing `resolve_program` appends that diagnostic and returns empty
tables. `check_program` stops before dependent passes, retaining earlier
diagnostics, catalog version and checked-cohort metadata. Ordinary recoverable
source errors retain their behavior.

The [three saved advisory replies](../resolver-admission/jev-response-1.json)
are weak and split: confidence .23/.36/.55; the first ties complete abort and
partial-prefix retention, the second favors complete abort and the third
favors partial retention. They provide no rationale. The shipped IDE also
calls the compatibility resolver for a tables view without retaining duplicate
diagnostics, and no existing caller promises useful tables after capacity
failure. Complete abort avoids presenting a valid prefix as a full result;
external demand for explicit partial-prefix support remains unverified.

The changed-source finite graph case passes **1/1**, preserving IDs, types,
edges and cycle precision. The existing `b4_resolve` target passes **11/11**,
including duplicate, trusted-handler, ownership and operation-alias paths.
Compilation exposed the explanation catalog's array count; it was corrected
before these passing checks. No billion-entry exhaustion, full-suite repeat or
full FAIL-R06 closure is claimed.
