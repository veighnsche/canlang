# Outputs and source transformations — audit Step 10

**Legal Can bindings can compile successfully into invalid JavaScript.** Actual
parameters named `class`, `await` and `default` are emitted as reserved bindings;
`c` collides with the emitter's context parameter. All four real CLI checks and
compilations exit 0; Node rejects their emitted modules. The `value` control
passes. This is a correctness repair with an existing language contract, rather
than a reason to introduce another compatibility adapter.

The audit adds **35 finite duties** to the existing [coverage ledger](coverage.jsonl):
[15 serialization families](output-evidence/serialization.json),
[13 transformations](output-evidence/transforms.json) and
[7 coordinate/identity boundaries](output-evidence/coordinates.json).
Each records defining declarations, callers, actual consumers, independent
authority, witnesses and gaps. Independent [review](output-evidence/review-transforms.json)
challenges root's probes; root challenges the serializer view and executes its
leads. Navigation links do not certify every branch of a referenced file.

Compiler source remains `1fd07722090fe70228a6b661e3c6e136275ca84b`; collection HEAD
was `0edfde19`, with early baseline commit `eb5ca8d`. [Inputs](output-evidence/inputs.json)
rehash historical compiler/runtime references and pin contracts, dependencies,
catalog and actual docs consumers. The fresh Cargo command selects reported
rlibs, rather than a stale glob. Installed dist and current source consumers are
distinguished; neither a package rebuild nor an installed release is inferred.
Sol 6.1 medium performs the bounded serializer scan and independent review;
additional agent dispatch hit the thread limit, so root handles the remaining
slices. The [researched allocation](../model-allocation-20261007.md) is reused
without escalation or a cost/quality benchmark.

## Contracts and observed outcomes

| Boundary | Qualified result and preservation limit |
| --- | --- |
| Exact values and scale | Typed fixtures preserve integer/decimal/duration/money strings, including `12345678901234567890.1200`, minor-unit precision and nested order. Actual artifact intake preserves `9223372036854775807`. Runtime Decimal literal emission remains E6008, so a constructed descriptor fixture does not prove that missing production path. Runtime encoding may normalize scale; descriptor defaults retain authored scale. |
| String escaping | Actual emitted defaults, message metadata and BDD closures execute six independent Unicode/control vectors through public testkit seams. Typed JSON release bytes distinguish controls, literal Unicode and quoting. Identifier allocation, expression printing and embedding belong to separate boundaries. |
| Omission, null and ordering | Independently authored typed fixtures cover absent optional metadata, present empty text, explicit null, required/serverOnly false, ordered arrays and reference variants. DTO byte guards are current adapter promises; consumer JSON parsing alone does not justify permanent field-order obligations. |
| Diagnostics | Human columns are one-based UTF8 **byte** columns. Reversing two public diagnostics with identical key/severity but different tags reverses output, contradicting the method's insertion-independent byte-order documentation. No actual CLI producer of that tie has been demonstrated. |
| Formatter | Recursive CST topology, exact nontrivia spelling and decoded string tokens survive 52 clean corpus files, plus bounded adversarial fixtures. The two known malformed drafts and malformed escapes/tabs are refused. LF, indentation and comment/description trailing whitespace are declared normalizations. This is stronger structural evidence than a leaf-only snapshot, but not universal semantic/runtime equivalence. |
| Lint fixes | Both live rules are exercised: remove a whole-line statement after `require false`, and replace `?.` by `.` for a proven non-null receiver. Rechecking and collecting fixes reaches a fixed point. Unrelated model and sibling-operation bytes survive. The unreachable statement's leading `##` comment is removed with its CST span; that preservation decision remains open. |
| Stale and invalid edits | Honest current-hash driver callers reject stale input; the IDE helper independently hashes offered text. Invalid ranges and overlapping batches refuse without partial results. The public driver requires the caller to supply the actual text hash and same-file fixes. CLI `lint --fix` reports edits and does not apply them. |
| CLI replacement | `fmt --check` leaves bytes unchanged, malformed later operands prevent earlier writes, and an equal-output run preserves inode/bytes. Native destination/permission/link/failure tests pass at their stated profile; one `4750` fixture branch cannot establish its requested bits and reports SKIP. No ACL, ownership, filesystem CAS or crash-durability guarantee is inferred. |
| LSP | A real framed session exercises current document versions, diagnostics and edits with CRLF, supplementary Unicode and authored non-file URI identity. The server advertises UTF16. A public byte-mode conversion helper does not qualify negotiation of another encoding. Client application and broader lifecycle state remain later work. |
| Source maps | Independent arithmetic decoding and actual Cloudflare location/failure consumers qualify the released original Can byte-column profile, ordered source/name registration, repeated paths, content and unmapped points. Generated points are line-column zero. This does not qualify browser debugger navigation or every emitted span's runtime attribution. |
| Documentation | Actual `can docs` enters the installed platform and public Markdown renderer. Defaults containing backticks, pipes or backslashes expose inline/table escaping defects in the package renderer. Fenced examples separately choose sufficient delimiter lengths and are not implicated. |

The Markdown interpretation is derived from the official
[CommonMark code-span rules](https://spec.commonmark.org/0.31.2/#code-spans)
and [GFM table rules](https://github.github.com/gfm/#tables-extension-): backslashes
are literal in code spans, embedded backticks require suitable delimiters, and
table pipes require escaping even within inline spans. The actual Markdown bytes
are captured; no Markdown parser or GUI rendering was executed. JSON transport
preserves those source defaults correctly. The observed defect is downstream.

## Executed witnesses and provenance

[Suite receipts](output-evidence/suites-execution.json) capture **113 harness
passes**: 97 across 18 selected integration suites, six source units, eight
replacement units and two native URI units. There are zero harness failures or
ignored tests, with **one reported `4750` branch skip**. These include real
artifact intake, public docs/policy consumers, source-map consumers, framed LSP
and all six emitted-string/testkit witnesses. The full compiler suite, release
footprint and other hosts were not rerun.

[Observer receipts](output-evidence/observer-execution.json) join
[61 distinct source cases](output-evidence/cases.json) to
[results](output-evidence/observations.json): 54 corpus inputs and seven focused
format/fix inputs. They preserve fresh build selection, command/cwd, stdout,
stderr, exits and hashes. [CLI receipts](output-evidence/cli-execution.json) add
18 real compiler calls and five Node module syntax checks. Nineteen forward
byte/human/UTF16 vectors and 32 inverse vectors have independently fixed expected
coordinates; inside-scalar/clamped offsets are intentionally not bijective.

[Later outcome verification](output-evidence/outcome-verification.json) records
377 assertions: 367 pass; ten are nonpassing outcomes, separated into four
compiler binding failures, one public diagnostic determinism failure, three
standards-derived downstream Markdown failures, one comment preservation gate
and one unqualified native mode branch. These later checks are labeled as such,
rather than presented as pre-execution oracles.

[Observer/review corrections](output-evidence/observer-corrections.json) preserve
a missing argument in the first audit-only probe compilation, a retracted
receipt-collision warning caused by comparing different hash domains, and the
tags-only diagnostic control. The original 61 case IDs were already unique;
path-derived IDs were added defensively and observers rerun. Tests were not
needlessly repeated. Superseded capture names in the original execution receipt
are explicit; final probe and suite receipts are separate. Temporary executables
are removed; saved recipes and inputs are reconstructable, not a hermetic bundle.

## Bounded repair and qualification packets

| Packet | Writer and exit |
| --- | --- |
| OUT-R01 — high, binding correctness | One `codegen/js.rs` writer traces identifiers, parameters, locals, lambdas, derive functions and generated temporaries. Use one scope-aware mapping from resolved identities to legal distinct JS bindings; retain authored property/wire names separately. Reserved-name and `c` fixtures must parse and execute through actual callables with ordinary-name controls. Account for mapping/source attribution and retire conflicting sanitizers; a new JS AST architecture is not required by this finding. |
| OUT-R02 — public determinism contract | `diagnostic.rs` owner qualifies whether callers need full tied-payload ordering or a narrower documented sort promise. The tags-only witness remains a regression candidate. Do not add ordering machinery solely to preserve an unsupported claim; no contract change is selected here. |
| OUT-R03 — downstream Markdown | Interfaces docs owner fixes inline code/table preservation through its actual public renderer, independently of compiler JSON. Cover embedded backtick runs, pipes and literal backslashes; retain fenced-example handling. Package edits require that owner's released packet. |
| OUT-R04 — comment preservation gate | Lint owner releases whether attached explanatory comments survive removal, move to retained context or deliberately leave with the removed statement. Preserve unrelated declarations and source anchors; consequential new policy requires verified-context JEV before selection. Current safe runtime meaning and comment preservation are separate claims. |
| OUT-R05 — remaining qualification | Keep `4750`/other-host replacement branches, browser map navigation, full runtime Decimal emission, broader source attribution and client application explicitly scoped. Release each only when its actual owning profile and consumer can be exercised. This gate does not block the witnessed binding repair. |

The same single ledger names exclusive writer closures and economical allocation.
Shared `js.rs` and serializer/LSP files require serialized releases; package
ownership is preserved. The existing complexity/complete-caller retirement gates
still apply. This audit accepts evidence and proposes repairs; it changes no
compiler/package implementation, dependencies, policy or API. Step 9 and Steps
11 onward remain proposed. No merge or living-plan checkpoint advancement occurs.
