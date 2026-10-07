# Resolution, types, effects and permissions — audit Step 8

**The bounded semantic audit found new compiler defects; the compiler is not yet
qualified as semantically correct.** Array inference erases nullable elements
depending on their position. Scheduled-handler scope inference omits queries in
derived functions. Real-catalog named `format` calls check successfully but cannot
lower, and positional calls fail against the installed public runtime facade.
These findings have independent language/owner references, paired controls and
review; they are implementable repair inputs, not completed repairs.

The single [coverage ledger](coverage.jsonl) adds 44 duty records, eight classified
finding/qualification records and input/execution joins. Supporting views are
[resolution](semantic-evidence/resolution.json),
[authority](semantic-evidence/authority.json) and
[values](semantic-evidence/values.json). Their exact defining declarations,
callers, consumers, inspected witnesses and remaining gaps qualify each duty.
Navigation references do not certify every responsibility band or semantic
cross-product in a file.

Compiler source remains `1fd07722090fe70228a6b661e3c6e136275ca84b`. Collection HEAD
was `1db4516c`; early contract/source-slice commit is `bbd7e89`.
[Inputs](semantic-evidence/inputs.json) rehash 107 compiler and 550 installed
runtime file references from the historical manifests, with no mismatch. Catalog,
normative design/grammar and package export/profile inputs are pinned separately.
Existing dist is qualified as executed input; no source/dist rebuild, installed
release or second-host acceptance is inferred. Three Sol medium lanes perform
bounded semantic traces and cross-review; Luna medium checks receipt arithmetic
and provenance. The same-day [researched allocation](../model-allocation-20261007.md)
is reused; no stronger worker or comparative cost/quality claim was needed.

## Finite responsibilities and authority

| Duties | Review and preservation boundary |
| --- | --- |
| Resolution, 12 slices | Module/declaration identity, exports/imports/composition, lexical/default ordering, contextual names, qualified types, closed argument binding, overload trials, expected types, nullability and catalog/unresolved ownership |
| Effects/permissions, 15 slices | Owning data/policies, read purity and authority, guard authorization/actor modes, disclosure, calls/imports, handlers/hooks, ordered mutations/intents, creation defaults, recurring scope, graph edge scopes, fixtures/migrations and diagnostic aggregation |
| Values/ICU, 15 slices | Exact scalar bounds/scale, authored units versus wire inputs, public bytes gap, currency data, ordinary URL versus trusted origin, email, locale, timezone, temporal constructors, typed ICU grammar/slots/disclosure, nominal metadata and the generated UI seam |
| Orchestration/joins, 2 slices | Actual dedup/sort/readiness and error gate; real overload binding through IR/JS and installed public imports, with the wider generated-execution audit still separate |

Owning declarations and DESIGN/GRAMMAR determine language obligations. Package
public exports and conformance/profile facts qualify the runtime side. Agreement
with either the previous implementation or a new dependency alone is insufficient.
`@canlang/ui` owns generated message descriptors; its `MessageFactory` differs
from `@canlang/values.makeMessageDescriptor`. The initial inference that a `url`
parameter necessarily fails generated intake was rejected. The executed UI plain
URL control succeeds, as does the public values pattern validator. No such defect
is carried into the repair queue.

The live catalog has 59 entries, including two external entries and no planned
entry. Ordinary same-arity overloads inspected here have matching parameter
names/order; `format` is the real special case with different parameter names.
The prior general analysis-specificity/IR-first-arity issue remains an unqualified
lead for other catalogs. A specialized decoder does not establish correct binding:
the executed named `format` cases demonstrate its concrete omission.

## Executed evidence and limits

[Native execution](semantic-evidence/execution.json) captures a fresh locked,
offline library/binary build, Cargo-reported rlibs, tool versions, command/cwd,
raw stdout/stderr, process exits and hashes. The observer uses `CatalogAnalyzer`
and production emission options through their real error gate.

- Eight selected integration suites (`analysis`, `b4_resolve`, `b4_check`,
  `effects`, `check`, `b4_examples`, `catalog_input_contract`, `value_admission`):
  **440 harness passes, zero failures, zero ignored, no reported SKIP**. Existing
  dedup tests execute exact-repeat collapse and distinct end/message retention.
  This is not the full compiler suite or every permission/effect branch.
- [47 initial inputs](semantic-evidence/cases.json) and
  [26 added inputs](semantic-evidence/extra-cases.json) retain exact source strings
  and input hashes: all 73 are syntax qualified. Controls cover default scoping,
  argument names/arity, actor/event contexts, private/exported/missing imports,
  deployment binding, nullability, availability, scope, exact values and formatting.
  Temporary binaries/source paths are gone; recipes/bytes/hashes are retained for
  reconstruction. This is not a hermetic replay bundle.
- Four controlled producer variants test `lower` as implemented/planned/external/
  helper. Their copied catalog also has an artificial non-semver version, which
  causes a synthetic emission-pin error. Their checking results qualify the
  admission path, not the real producer's release behavior. Real named-format and
  all ordinary source/value fixtures use the unchanged installed catalog.
- Twelve fresh processes reproduce the existing static-call cycle defect: two
  different complete E3005 message/closing-edge-span sets for identical input.
  Ownership upstream `U`, `A`, `B` each diagnose E2008; call upstream `u` is excluded.
  Different graph policies are intentional and must not be replaced by one SCC
  membership rule. Existing Pass 9 multiplicity/overlap/fixture/composition evidence
  retains its historical build-provenance limits.
- [70 public-owner calls](semantic-evidence/owner-observations.json) execute actual
  installed values/UI root exports, including encode/decode errors, bounds,
  Gregorian and post-offset ranges, ICU operand types, canonical locales and
  currency data. Constructor and wire grammars, authored units and owner API
  preconditions are kept distinct.
- [Eight real CLI calls](semantic-evidence/cli-observations.json) confirm the
  array case compiles successfully only in the first-fixed ordering. Derived scope
  checks clean but compile rejects E6008; named-format checking also succeeds but
  compile rejects E6008. These later refusals rule out a demonstrated deployed
  recurring permission bypass.
- [Generated execution](semantic-evidence/generated-observations.json) imports
  two actual emitted pure functions against installed stdlib/UI: both positional
  `format` calls throw `ValueError/invalid-construction`. The public plain-format
  control returns the independently specified `Hi Bo`. An empty context caller
  suffices to expose the wrong argument boundary; this does not qualify activation,
  server/browser operation or the original/installed application.

[Later outcome checks](semantic-evidence/outcome-verification.json) record 188
assertions: 179 pass and nine expose the named compiler/profile/determinism
failures. They separately correct two mistakes in the attempted oracle: user-call
argument type rejection is E3001 rather than E3005, and 38 integer digits followed
by authored `.0` contain 39 significant digits. Original expectations and raw
receipts remain saved; these corrections are not additional compiler defects.

## Classified repair and qualification packets

| Packet | Finding, writers and acceptance |
| --- | --- |
| SEM-R01 — high | `types.rs::type_array` compares stripped element types but retains the first nullable state. Both element orders must reject unsupported nullable elements under DESIGN139, preserve exact error anchors and handle expected-array paths. No runtime crash/disclosure is established by the `count` fixture. Use one type-join policy; do not add another inference engine. |
| SEM-R02 — high | `effects.rs` recurring dependency closure includes scenario models and statement calls but misses derived expression dependencies. Include the existing bound derive/query facts; mixed app/team dependencies must diagnose E4051 at the handler in direct, scenario and derive forms. Creation-default/server initializer transitivity remains a separate question. No new scope policy or permission bypass is selected. |
| SEM-R03 — high | `ir.rs::decode_format_call` loses named binding and ordinary values; `js.rs` emits three arguments with context to a two-argument installed facade. DESIGN1085 proposes that context-aware generated signature, so the observed runtime failure establishes an owner seam mismatch without choosing which API changes. IR owns binding/value loss; JS and stdlib/values facade owners must qualify the signature together before release. Consume the selected binding once and qualify both output families, values/options, locales and evaluation order. Retire reconstruction after equivalent consumers pass; Step 9 owns the wider execution closure. |
| SEM-R04 — owner policy gate | Compiler email rejects `a@b`, `a@localhost`, `a@-x.com`, Unicode domains that the public codec admits; compiler admits an NBSP local part rejected by both public directions. DESIGN's “validated email” does not settle every floor choice. Define a shared admission obligation with verified-context JEV before a consequential policy change; do not install a second large compatibility parser. |
| SEM-R05 — finite qualification gate | Compiler accepts date operands for `{d,time}`; both actual owner APIs refuse them. The static date/datetime merger needs an explicit formatter type partition; do not invent a midnight rule. `Mars/Olympus` also passes structural checking and fails actual timezone membership. Existing data-version/staging obligations remain explicit; timezone data is not another shape heuristic. |
| SEM-R06 — package findings / compiler seam | UI accepts decimal integer/ordinal operands that DESIGN895, compiler and values reject; UI rejects valid year 0001/0099 date strings. UI also rejects tagged values date/datetime/Decimal objects at the joined public API. Its own string preconditions and the compiler's source-visible emitted constructor path are distinguished. Full generated temporal/Decimal execution remains a Step 9 witness requirement. Package owners hold their writers; no package edit is authorized by this compiler audit. |
| SEM-R07 — existing graph packet | Current source rebuild reproduces G09-1 nondeterministic call-cycle witness. Preserve edge scopes, upstream exclusions, multiplicity, source anchors and fixture seed order; settle a deterministic origin/witness policy in its previously gated packet. A graph library alone does not choose diagnostics. |
| SEM-R08 — source leads / bounded gaps | Overload trial node-type mutation, lenient unknown catalog nominal matching, all alias/same-arity cross-products, authority-derived scalar provenance, default/server dependency closure, public bytes owner capability and full temporal/presentation handoff remain unqualified. Release specific next witnesses against named owners; do not treat the collection as authority to rewrite every semantic owner. |

The current public aggregation key is `(file,start,end,code,message)` and keeps the
first exact repeat; severity/related/tags are outside that key. No actual loss
from differing related metadata is demonstrated here. Sorting `(file,start,code)`
cannot repair graph witnesses whose content/span change before aggregation.
`complete=true` means required passes ran; the Step 7 subtree omissions and these
Step 8 semantic findings prevent it from certifying all facts.

## Review, retirement and next scope

Independent Sol medium cross-reviews of
[resolution](semantic-evidence/review-resolution.json),
[authority](semantic-evidence/review-authority.json) and
[values/consumer ownership](semantic-evidence/review-values.json) accept the
bounded findings and challenge absent cross-products, runtime overclaims and
false owner assumptions. [Luna receipt review](semantic-evidence/receipt-review.json)
checks inputs, command hashes and arithmetic. [Validation](semantic-validation.json)
checks joins, current pins, exact source hashes, retained prior inventory and raw
capture integrity. Source review and mechanical validity are separate evidence.

No production code, tests, dependency graph, package source or policy is changed.
The current production count remains 69,255 versus original 69,119, net +136.
These repair packets should remove reconstructed semantics and retire their old
paths after acceptance; an added adapter is not itself an exit criterion.
Existing locale/ICU/temporal/graph/JEV gates remain open. Earlier rejected JEV
transmissions are not retried or waived. No merge or living-plan checkpoint
advance occurs. Steps 9–16, broader permission/evaluation/resource/oracle review,
T37 and installed-release parent acceptance retain their declared scope.
