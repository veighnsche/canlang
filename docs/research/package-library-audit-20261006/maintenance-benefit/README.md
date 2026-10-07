# Before/after maintenance assessment

Planning assessment, 2026-10-07, at
`d253b2f1a91ad3ce9259f9aa57aa33be291fd289`. Implementation remains deferred.
The prior library batch has **not demonstrated a net production reduction**:
implementation-bearing source rose by 113 lines and maintained declarations by
83, a combined 196 lines. That historical batch also contains correction,
assembly and capability work; the whole increase cannot honestly be attributed
to library wrappers alone.

All [27 library families and 49 duplication review records](assessments.md) have
before/proposed-after assessments. The 49 records include 31 conditional changes
and 18 retained boundaries; they are not 49 new tasks. DR08 remains an alias of
DC-01. [Machine assessments](assessments.jsonl) preserve exact current ranges,
source hashes, historical envelopes, maintenance vectors, counterevidence and
qualification costs. Family/candidate and source-file overlaps are explicit;
their potential savings must not be added together.

## Measured historical result

The verified [production baseline](../production-baseline/README.md) compares
`309644a` with `8f33aa5`. The entire 844-file package tree, root package manifest
and lock still match that later snapshot at this audit's freeze. Compiler and
editor source are outside the measurement denominator.

| Maintenance measure | Before | Current | Change |
| --- | ---: | ---: | ---: |
| Implementation-bearing physical lines | 108,087 | 108,200 | +113 |
| Maintained declaration lines | 14,591 | 14,674 | +83 |
| Combined runtime candidate source | 122,678 | 122,874 | +196 |
| Distinct declared external runtime npm libraries | 2 | 9 | +7 |
| npm export subpaths | 154 | 156 | +2 |

Physical lines include comments/blanks at readable source layout. Inline Rust
tests, other tests, fixture data, generated/runtime data, scaffolds and documents
are separately classified. Runtime candidates include unadopted native code and
are not a claim of shipped size. Dependency counts measure declared libraries,
not transitive closure, release cadence, safety or license-compliance acceptance.

[Historical details](historical-before-after.json) include every package owner
and affected-file envelope. Cloudflare grew by 241 implementation/declaration
lines; Values by 98; Identity by 22. Interfaces fell by 73, Services by 47,
Work-kernel by 44 and UI by one. Schema/wire implementation transfers earn no
removal credit. These owner totals contain mixed work and are not causal scores
for an individual integration.

There are genuine local reductions: the Values formatter body changed from 25
nonblank source lines to 16, and Rust-str quoting from 21 physical lines to three
through existing serde_json. These remove custom mechanics. They do not by
themselves establish the all-owner net gain, full lossless UTF16 capability,
installed qualification or backend retirement.

## Remedies most likely to pay their maintenance cost

| Remedy | Proposed before → after | Gross duplicate-body opportunity | Remaining cost/gate |
| --- | --- | ---: | --- |
| DR01: State SQLite leaves | Two query/conversion copies → one private mechanics owner | 212 physical lines | Keep async D1 and synchronous DO transaction/effect ownership separate; include helper/types/imports and exact binding/conversion errors. |
| DR03: UI appearance | Ten 22-line projection bodies → one private leaf | 198 | Count imports and shared typing; preserve getter read/order, inheritance and each renderer's output. |
| DR04: UI draft leaves | Two copies of six value leaves → one copy each | 104 | Keep renderer orchestration, exact text/zero/field-error and getter behavior. |
| DR09: Service harness leaves | Repeated reader/sendBody leaves → common Node mechanics | 89 | Preserve host/runtime/public support contracts and acquisition/cleanup order; optional socket extraction excluded. |
| DR02: State freeze/path leaves | Four freeze and two path copies → one of each | 62 | Preserve traversal/freeze/error timing and update caller imports/signatures. |
| DD-001: held preparation adapter | Copied Bun/catalog bodies → existing owning exports | 123 selected source lines | This is a copied-source envelope, not net savings. Pay delegates/imports and phase/marker/cleanup behavior; preparation remains held. |

These are **conditional opportunities**, not accepted reductions or numbers to
sum. Some smaller forwarders have too little source to pay for new imports and
compatibility exports. Moving TestOnly helpers, ports or native prototypes to
different files produces zero reduction. Removing required TS/reference/owner
paths before their original retirement gates is not an eligible remedy.

Already-adopted CSV, scure codecs, native comparison, cookie and AbortSignal.any
seams contain legitimate owner policies; another wrapper does not help them.
Import/Unicode recovery and raw source-map compensation have no demonstrated
further reduction. A parser/SDK that needs a second semantic engine remains a
poor simplification candidate. CSV-stringify's four-line quote-leaf opportunity
must pay all new options, adapters, exports, declarations and dependency burden.
Retain-now remains reasonable where a simpler same-outcome candidate is absent.

## The replacement acceptance gate

[Machine gate](acceptance-gate.json) applies the human's requirement to every
replacement-only packet, including a replacement subpiece of mixed work:

1. Freeze the same required outcomes and the complete affected owner/caller scope.
2. Show a strict decrease in readable implementation and in implementation plus
   maintained declarations. Charge every new helper, adapter, import, type,
   caller, error mapping and retained compatibility route. Record configuration
   and dependency costs separately too.
3. Compare owned algorithms, compatibility branches, representations, lifecycle
   states/resources, dependencies and upgrade work. Explain any worsening rather
   than hiding it in an invented weighted score.
4. Verify real consumers, independent oracles and decisive refusal/lifecycle
   controls at the claimed scope before removing old mechanics.
5. Credit real deletion/consolidation, never source compression, file moves,
   generated output or relocation into tests/support code.

No prospective remedy has a concrete changed-source candidate in this round.
Future exact implementation/declaration totals are therefore `null`, and all
proposed net-reduction acceptance flags are false. The assessment measures the
before state and historical local changes, and states the conditional after
obligations without pretending a forecast is an executed result.

## Separate capabilities, corrections and evidence

[Separate scope/budget register](separate-budgets.json) cross-references all 69
existing protocol/security/lifecycle/runtime/test/evidence queue groups. They
overlap each other and the 76 assessment records; they are not additional
canonical obligations or additive cost estimates. Safety/correctness repairs
may legitimately grow code but cannot be billed as replacement savings.

Full Values/validation consumers, native Work delivery, held preparation and real
mounted product joins require separately finite scopes and source, dependency,
representation, lifecycle/runtime and qualification budgets. Those growth
budgets are explicitly **unallocated**, not assumed zero-cost or approved.
Before future dispatch, choose the actual packet, inputs, owners and ceilings;
do not smuggle the capability into a reduction-only change. No person-hour or
net-LOC estimate is invented without a candidate.

Test/corpus/document reduction is a separate maintenance benefit. Preserve
independent oracles, red/excluded results, real D1/DO/workerd/installed controls
and exact provenance. It does not satisfy the production-reduction gate.
The [480 adapter groups](branch-coverage.json) are scoped classifications, not
cyclomatic complexity; proposed branch dispositions are not measured after counts.

Three bounded Sol medium assessments and a finite Sol medium opposing review
checked these comparisons. [Counter-review](counter-review.md) retains the
largest deletion-envelope checks and scope qualifications. [Source/metadata
verification](verification.json) checks hashes, ranges, coverage and original
source identity only. No builds, product tests, installs, runtime/network probes,
package changes, canonical task/status changes, new policy, merge or living
filetree checkpoint advancement occurred. The separate pending critical Astra
review and original T08/T26/port/host/retirement gates remain separate.
