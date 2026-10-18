# Bounded ICU grammar and shared-parser plan

**18 October 2026 · approved grammar; TS sharing, compiler consolidation and UI usage complete.**
The source investigation below retains its historical baseline at
`0bb480bef36b8a4aa9dafd932a06443f5543d33c` (inspected product files unchanged from
`08dc8c392`). The user approved the grammar profile, then separately released
Shared TS syntax, compiler parse/usage consolidation and UI full-signature usage for
[package-audit candidate 1](README.md#1-shared-bounded-message-syntax--strongest-semantic-consistency-opportunity).
The three implementation packets and their finite joined checks are complete at
the recorded scopes below. Native preparation remains **HUMAN HOLD**.

**Accepted profile and staged direction:** use the Values grammar as the explicitly
documented baseline. Values and UI share its TS parser; compiler syntax and
placeholder discovery now share one private Rust parser. Retain these two
implementations. Consider one Rust implementation
serving all three only in the bounded follow-up below; do not require Wasm to call
today's synchronous public TS parser as an incidental refactor.

The [Rust start guide](../../implementation/RUST-PORT-START-HERE.md#current-execution-view--2026-10-18)
remains the single execution view. Steps below are finite subdivisions of this
candidate, with links to existing compiler correctness packets, not new canonical
task IDs or a second dispatch queue. Existing A/V/W/C04 readiness and accepted
components are unchanged.

## Contract and current owners

[DESIGN §9.1](../../specification/DESIGN.md#91-built-in-internationalization)
requires one bounded profile: named placeholders, number/integer, date/time,
nested plural/selectordinal/select with mandatory `other`, exact numeric cases,
apostrophe-friendly quoting and full signature checks. It excludes offsets,
choice, custom/skeleton styles and rich-tag handlers. At investigation time it
did not spell out every lexical rule, outside-plural `#`, or the depth-counting
unit. Those were explicit proposal choices; the user has now approved the common
grammar column below.

| Owner | Actual entry and responsibility | Preserve at the adapter boundary |
| --- | --- | --- |
| Values | [`src/icu-syntax.ts`](../../../packages/values/src/icu-syntax.ts): shared syntax/normalization/diagnostics; [`src/icu.ts`](../../../packages/values/src/icu.ts): public parser, `messageUsages` AST traversal, validation, descriptors and rendering; root exports in `src/index.ts` | Public AST/node shapes and exact bigint selectors; `ValueError`; own-key binding checks; numeric admission; locale/Intl and formatting |
| UI | [`src/messages.ts`](../../../packages/ui/src/messages.ts): shared syntax/usage consumer; `message`, `formatMessageResult`, captions/components; former private parser removed | Contracts descriptors, optional owning `sourceLocale`, resolved type IDs/native operands, public error family, locale selection, exact rendering, HTML escaping and `lang`/direction |
| Compiler | [`analysis/icu.rs`](../../../compiler/src/analysis/icu.rs): syntax, ordered valid-pattern usages and declaration/type checkpoints; [`analysis/examples.rs`](../../../compiler/src/analysis/examples.rs): `IcuType` mapping and `icu_error` adapter; [`analysis/types.rs`](../../../compiler/src/analysis/types.rs): coverage, anonymous binding and static-caption consumers | Source signatures, explicit binding, disclosure/provenance, source/variant ownership, diagnostic codes/order and whole authored-literal spans |

UI already imports and depends on Values; Values depends on Contracts, so parser
reuse adds no package cycle. Compiler already depends on `values-semantics` for
other work; a later shared Rust core would not inherently require another crate.
Neither fact supplies the missing cross-language parser transport or adoption.

## Historical grammar differences and approved disposition

These are **historical source-derived witnesses** at the baseline pin above,
not descriptions of the updated TS consumers. Values parser
rules are at `icu.ts:240–557`; UI at `messages.ts:382–605`; compiler at
`examples.rs:3295–3580`. Use explicit declarations of the named operands when
checking compiler syntax so undeclared-name diagnostics do not obscure the case.

| Case | Values at baseline | UI at baseline | Compiler ICU checker at baseline | Approved common grammar |
| --- | --- | --- | --- | --- |
| Bare `#` | Literal text | Literal text | E5007 outside plural | Literal outside plural; nearest enclosing plural inside it. Resolve existing `I-POUND-POLICY` this way. |
| `#` inside select inside plural | Uses outer plural | Uses outer plural | Retains outer plural context | Preserve; nested plural replaces the active number. |
| `Don't {n}`, `It''s {n}` | Friendly apostrophe / doubled apostrophe | Same | Same in ICU parser; coverage scanner differs below | Preserve. |
| `'{''}'` | Literal `{'}` | Literal `{}`: quote closes too early | Literal `{'}` | Doubled apostrophe inside a syntax quote stays inside it; fix UI. |
| `'\|'` and two-character `'\|` | Ordinary apostrophe/pipe text | Pipe starts quote; unclosed form fails | Pipe starts quote; unclosed form fails | Only `{`, `}`, `#` trigger syntax quoting. Pipe has no special syntax in this bounded profile. |
| `'{n}` | Unterminated quote error | Same | Same | Require closing syntax quote; do not inherit a full ICU library's optional close. |
| `{0}` / `{_}` | Accept as named keys | Accept | Digit-start rejected / underscore accepted | `[A-Za-z0-9_]+` keys, retaining Values API. No positional binding; Can declaration names remain separately constrained. |
| `{a-b}`, `{a.b}`, `{é}` | Reject | Accept as argument names | Reject | Reject. UI tightening must be declared in the migration. |
| `{n,\tnumber}` (`\t` means a tab) | Accept | Tab becomes part of format name; reject | Accept | Pin the Values whitespace set explicitly. |
| `{n\t}` | Name `n` | Name includes tab | Name `n` | Same whitespace rule; never infer a tab-bearing name. |
| `U+0085` / `U+FEFF` around tokens | Not whitespace / whitespace | Neither skipped | Whitespace / not whitespace | Values set: exclude U+0085, include U+FEFF. |
| `{n,number,}` / `{d,date, }` | Reject empty explicit style | Defaults the style | Reject | Omission defaults; an explicit comma requires a supported style. |
| `{n,plural,banana{x} other{y}}` | Reject unknown category | Accept unreachable category | Accept category identifier | Only `zero/one/two/few/many/other`. |
| Exact `=1.5`, `=9007199254740993` | Accept without Number conversion | Accept without Number conversion | Accept raw digit strings | Preserve exact values and source order; no int32/Number selector limit. |
| Exact `=-1`, `=+1` | Reject both | Accept both | Accept minus, reject plus | Retain unsigned `digits(.digits)?` in the approved profile. Negative operand values remain valid; signed selector syntax is a separate possible language extension. |
| Exact `=.5`, `=1.`, `=1e2` | Reject | Reject | Accept first two; reject exponent | Reject all three. |
| Exact `=01.00` plus `=1` | Duplicate numeric value | Duplicate numeric value | Different lexical keys | Reject duplicate normalized exact value. Preserve big coefficient/scale, not floating-point equality. |
| Select keys `active-case`, `1`, `-` | Accept | Accept | Reject | `[A-Za-z0-9_-]+`, as existing Values profile. |
| Select key `=1` | Reject | Accept as string key | Reject | Exact selectors belong only to plural/ordinal. |
| Select key `a.b` / non-ASCII key | Reject | Accept | Reject | Reject; no arbitrary-token selector dialect. |
| `offset:1` | Reject wherever encountered | Reject first option; a later `offset:1{...}` can be accepted as a word | Reject | Reject everywhere, including offset zero. |
| `<b>x</b>`, `<x/>` | Reject recognized tag-shaped syntax | Literal, subsequently escaped at HTML sinks | Literal | Use Values' finite tag recognition/rejection. Bare `<`, `<3`, `a < b` remain literal. No handler or sanitization feature. |
| 32 nested complex arguments, then text | Accept | No explicit limit | Accept | Accept. |
| 32 nested complex arguments, then `{n}` | Reject depth 33 | No explicit limit | Accept: counts branch depth | Reject; count every argument, check before recursive descent. |
| Missing `other`, duplicate ordinary key, choice/custom/skeleton style | Reject | Reject | Reject | Preserve the bounded refusals. |

Whitespace is the finite set U+0009–000D, U+0020, U+00A0, U+1680,
U+2000–200A, U+2028–2029, U+202F, U+205F, U+3000 and U+FEFF.
The approved profile adds no Unicode normalization or case folding. Literal text, including
supplementary characters, is retained. Values/UI accept JS strings containing
lone surrogate code units; a future Rust boundary must preserve them or obtain
an explicit public-domain change, not silently replace them during UTF8 conversion.

The baseline is a compatibility choice, not a claim that Values defines all
language policy by accident. It avoids taking the union of permissive dialects
or adding full ICU syntax. The intended changes are exactly the differing rows
above, plus the usage/diagnostic dispositions below. Existing all-agree behavior
and unrelated numeric/locale behavior remain outside the change.

## Usage discovery is part of the finite consolidation

At the investigation baseline, the compiler's earlier coverage pass was another
grammar implementation, not just a list operation. `types.rs:11922–12040`
differed from its ICU checker:

- `Don't {ghost}` is hidden by the scanner's quote-to-next-apostrophe rule;
  `{ ghost }` misses the placeholder because it does not skip leading space.
- A spaced typed head can fall back to flat scanning. Negative exact keys can
  abandon branch scanning and mistake a branch body such as `{one}` for an
  argument. Unicode/digit-start names can produce coverage noise before the
  stricter ICU checker rejects the grammar.
- The implemented consolidation derives names and usage kinds from the same
  parser that validates syntax, retaining source order and all branches.
  Selectors, quoted text and branch prose are not arguments. Malformed patterns
  supply no speculative slots; E5007 retains syntax/type failure ownership.
  Removal of malformed-input E3016/E3013 noise is an explicit approved change.
  Anonymous binding retains admitted supplied schemas for typed checkpoints;
  a malformed pattern cannot establish that a supplied argument is unused.
  Duplicate binding and value-admission errors remain unconditional.

The completed compiler consumer list is finite: named source/present variants; explicitly
bound anonymous descriptors; selected raw format leaves through checked
aliases/choices; remaining inline structural checks; static contributed-field
captions; and the four former `message_slots` call sites for source/variant
coverage, page context-free checks and anonymous binding unions. The first three
use the shared valid-only name helper; anonymous binding consumes the same parse
result directly so it can preserve its schema on malformed input.
Anonymous typed schemas already reach `IcuParser` (`examples.rs:293–316`);
historical Pass9 wording that all anonymous descriptors are structural-only is
no longer current. Keep plain `scan_format_template` for the separate machine
template overload outside this migration.

Before the UI usage packet, supplied operands were converted eagerly but usage
was checked only in the rendered branch. Thus `{s,select,a{ok} other{{missing}}}`
with `s="a"` succeeded; `message()` also left source/variant syntax unchecked.
Those full-signature gaps are now closed at the selected scope.

UI validates syntax and declared usage in source and every present variant,
including unselected branches, using Values' existing traversal exposed as
`messageUsages`. Rendering stays on the selected locale/branch. Construction
performs metadata/wrapper checks first, then syntax and type-only usage checks
without converting operand values. With absent `params`, construction remains
syntax-only and binding waits until formatting. Formatting also checks structural
descriptors after locale resolution and eager conversion of every supplied value;
it relies on no factory brand. A per-call pattern map reuses the selected AST and
parses each distinct needed pattern once, in source then present-variant order.
Earlier factory/all-branch failures are intentional changes under this release.
Literal captions and already resolved text are never reparsed.

The effective formatting signature remains `options.args ?? descriptor.params`;
explicit arguments keep their complete override behavior. UI retains own-key
handling, including own `__proto__`, without Values' reserved-name constructor
rule. Inline `enum(...)` declaration metadata uses Values' existing type-ID parser
at construction so descriptor carriers still reach their working Values formatter.
UI's formatting sink keeps its existing ownerless-enum value-admission refusal;
this packet does not broaden renderer admission or validate enum case membership.

## What sharing must preserve

Syntax, type usage and host behavior have different boundaries:

| Boundary | Finite requirement |
| --- | --- |
| Typed usage | Plain placeholder permits declared display scalars; ordinary number/cardinal accepts int or decimal; integer/ordinal requires int; date accepts date or datetime; time requires datetime; select accepts text/bool/enum. Retain the already repaired compiler numeric/date-time rules. |
| Values API | Keep existing `parseMessageFormat` and AST output, exact selector `{coef: bigint, scale}` and ordered branches. Do not silently add enumerable location fields or claim a new deep-freeze guarantee: current freeze is not recursive over every nested node. Keep `ValueError` code/message behavior for unchanged failures. |
| UI errors | Keep ordinary Error, JSON-quoted pattern and UTF16 offset. A shared syntax result needs a narrow diagnostic kind/cursor/argument-start facility so UI can project its error positions; preserve unchanged positions and explicitly list changed grammar failures. Do not catch ValueError and reparse with the old UI grammar to recover an offset. |
| Compiler errors | Keep E3016 coverage, E3013 static-sink restriction, E5009 signature admission, E3005 explicit binding and E5007 syntax/type reason ownership. Keep whole authored-literal spans; decoded UTF16 offsets are not authored byte offsets. No precise source-map project is required. |
| Compiler precedence | Number style is checked before type; date/time type before style; plural/select type before branch syntax; selected anonymous/static declaration existence before subsequent delimiter syntax. `compiler/tests/check.rs:781–799` pins part of this. A syntax-first AST followed by type validation would change it. |
| Runtime order | Values `renderMessage`: parse, argument container, locale/timezone, all referenced bindings/usages, render. UI formatter: resolve locale, convert every supplied operand, parse/validate usage, render. Keep these adapter orders except the explicitly added all-pattern/all-branch checks; unused supplied UI values remain eagerly admitted. |
| Descriptors | UI Contracts descriptor has optional `sourceLocale`, resolved type IDs and no required Values `kind` field. Keep capture/provenance/eager `choose` behavior and existing factories. Values descriptor and renderer are not drop-in UI replacements. |
| Formatting | Keep Intl/locale/zone selection, exact numeric checks, currency scale, HTML escaping and host failures with their present owners. Do not change release-pinned locale data or reopen accepted V05 Node qualification. |

UI/Values **rendering parity is not established**: UI strips trailing decimal
zeros, localizes digits, accepts larger bigints and maps unsafe integers to CLDR
representatives; Values retains stored scale/Latin digits and refuses some unsafe
category operands. Existing tests pin these behaviors. They require a separate
numeric-formatting contract if harmonization is later requested. Shared parsing
must not be described as full formatter parity or proof that every current
numeric behavior satisfies the intended language contract.

## Finite packets and dependencies

The grammar profile and all three finite implementation packets are released and
complete at the scopes recorded below. Their joined criteria are satisfied by
validation of the released UI packet and retained producer evidence; no additional
intake or unchanged qualification run is required. A future single-Rust-core
evaluation remains dormant and requires its own release, not whole A/V/W completion.

| Packet / existing scope | Defining owner and concrete prerequisite | Remaining change and observable acceptance |
| --- | --- | --- |
| Profile and witness decision — candidate 1; existing `I-POUND-POLICY` | Language/Values + Compiler/UI; this matrix, owner tests and existing C09I cases | **Grammar profile approved**, including literal outside-plural `#` and the listed lexical changes. TS, compiler and UI implementation were separately released and completed. |
| Shared TS syntax — candidate 1 | Values writer then UI writer; approved profile/change list | **Released and complete.** Values owns shared syntax/selector normalization and narrow diagnostics; its existing wrapper preserves ValueError/AST behavior. UI consumes the AST in its own renderer; `PatternParser` and `PatternNode` are removed. Approved grammar, UI offset projection, nearest `#` and existing message/caption consumers pass as recorded below. |
| One compiler parse/usage owner — existing C09I `I-COVERAGE`, `I-TAGS`, `I-PLURAL`, `I-SELECT`, `I-DEPTH`, `I-EXACT-LEXICAL`, `I-POUND-POLICY` | Compiler; approved profile/cases, existing IcuType mapping and current anonymous-schema outputs | **Released and complete.** Private `analysis/icu.rs` owns syntax and ordered valid-pattern usages. All listed consumers share it; the permissive slot walkers and old examples parser are removed. Narrow declaration/type callbacks preserve the original checkpoints, whole authored-literal spans and malformed recovery. Original finite criteria and named/anonymous formatter consumers pass below. Accepted `I-TYPE` stays a regression check. |
| UI full-signature usage — existing candidate 1 / DESIGN §9.1 consumer obligation | UI with Values usage producer; shared TS syntax result and type-only AST traversal | **Released and complete.** Source/present-variant/all-branch syntax and declared usage checks use the shared AST traversal and UI's type/error adapters. Unselected invalid usage refuses; differing signature subsets, native operands and resolved text retain their contracts. Rendering, eager value admission and per-call AST reuse are preserved, with no new descriptor carrier. |
| Joined completion — consumes the three outputs above | Values/UI/Compiler owners; exact changed producer closure | **Selected criteria satisfied.** Current TS shared cases/usage tests and the two existing compiled formatter consumers pass; unchanged compiler profile and diagnostic checks are retained. Literal captions, own keys, exact large/fractional branches, offsets and dual-fault ordering are covered. Each outcome is credited once; broader formatter parity, ownerless UI enum adoption and host/native qualification remain outside this scope. |

The completed TS, compiler and UI packets share the approved profile and cases.
Their finite handoffs are consumed; no remaining assignment is created by this
completion record. Values owns syntax/usage exports, UI owns its validation and
rendering adapters, and Compiler owns its analysis integration. No heavy cache,
native preparation slot, installer programme or additional worktree is allocated.

Use the existing real consumer entries, not a new integration harness:
`localized_format_preserves_checked_owners_and_runtime_arguments` in
[`compiler/tests/localized_format.rs`](../../../compiler/tests/localized_format.rs),
and `anonymous_messages_compile_and_execute_native_date_time_and_plural_bindings`
in [`compiler/tests/anonymous_message_bindings.rs`](../../../compiler/tests/anonymous_message_bindings.rs).
Together they exercise compiled named/anonymous formatting, installed Values/UI
package consumers, source/app fallback, native operands and capture order.
Their Cloudflare assembler modules are source-loaded; do not claim a fully
installed Cloudflare-loader qualification. The anonymous consumer's explicit
ownerless-enum UI refusal remains a gap, not newly supported enum coverage.
Keep the existing Values ICU and UI message suites for their adapter behavior;
UI's message suite now includes own-versus-inherited binding regressions at the
existing selected-usage boundary; reuse them for any later usage packet.

Implemented TS and compiler allocation remains small:

- Values keeps `src/icu.ts` for public wrappers, shared `messageUsages` traversal,
  descriptor validation and formatting;
  private `src/icu-syntax.ts` now owns syntax/normalization and diagnostic data.
  Root `parseMessageSyntax` is the narrow shared entry; existing exports remain compatible.
- UI keeps its descriptor/resolver/renderer in `src/messages.ts`; it now consumes
  Values nodes and diagnostics without importing Values rendering.
- Compiler's private `src/analysis/icu.rs` owns one grammar/usage implementation
  and validation checkpoints, consumed by `examples.rs`/`types.rs`. It adds no
  crate, dependency, public transport or rendering owner.
- The shared plain corpus at `packages/values/test/fixtures/icu-profile.json`
  contains 24 accepted and 40 refused syntax cases consumed by Values and UI.
  Compiler tests reuse its 63 Unicode-scalar cases; the lone-surrogate TS witness
  remains explicitly outside Rust authored-string input. Existing owner suites
  cover host errors, rendering and depth; C09I remains the historical baseline.

## Shared TS syntax completion — 18 October 2026

Only the released TS syntax packet is credited here. `icu-syntax.ts` owns the
single TS grammar, exact-selector normalization and narrow diagnostics;
`icu.ts` preserves the existing public parser, ValueError messages and AST
contracts. UI consumes that syntax result once after its existing locale and
eager supplied-operand admission, projects ordinary Error messages with UTF16
offsets, and renders nodes with its existing exact numeric and Intl behavior.
At that TS checkpoint, descriptors, operand admission and selected-branch usage
remained unchanged apart from approved grammar changes. The separately released
full-signature packet is completed below.

Contracts, Values and UI emitted and typechecked. The focused ICU, locale,
messages and components run passed 241 tests. After diagnostic fixes, the affected
ICU/messages scope passed 165 tests; the unchanged 76 results were reused. The
checks cover the 64-case shared grammar corpus, exact diagnostics, depth,
nearest-plural `#`, own bindings and existing rendering/caption behavior. A
temporary isolated copy of Contracts/Values/UI manifests and emitted output also
passed public package exports, quoted text, high-precision exact branch selection,
locale fallback, literal/descriptor captions and diagnostic checks. The temporary
copy was removed. Those TS checks did not claim compiler consolidation, the later
compiled-to-installed join, tarball/browser-asset qualification or native release.

## Compiler parse/usage completion — 18 October 2026

The user released this packet against `7700621fa`. The new private parser returns
ordered names and usage kinds only for valid syntax. Its declaration hook runs
before delimiter parsing; number style precedes numeric type checks, while
date/time and plural/select types precede their later syntax checks. `examples.rs`
retains the existing type mapping and E5007 adapter. `types.rs` retains E3016
coverage, E3013 static-sink restrictions, E3005 explicit binding and E5009 value
admission; syntax failures no longer create speculative slot diagnostics.
For a malformed bound anonymous pattern, supplied types still reach E5007's
checkpoints rather than being discarded as unused bindings. Valid patterns
retain the ordinary extra-binding refusal.

Validation passed: two parser unit tests cover the 63 shared scalar-string cases
and ordered usage kinds; 38 existing check tests, 10 ICU-profile tests, six named
coverage tests, three temporal-message tests and nine anonymous-binding checks
pass (68 distinct Rust tests). The alias/choice test passed again after adding
unselected/nested choice and unchanged machine-template controls. Unchanged
parser/check results were reused after the isolated anonymous-schema correction.
That correction has a confirmed failing-before/passing-after regression.

The two existing named/anonymous formatter consumer scripts also pass using a
frozen current compiler binary, local Values/UI emitted output, cached dependency
outputs and Node24's `--experimental-transform-types` for source-loaded Cloudflare
modules. They cover source/app fallback, native date/time and plural bindings,
exact formatting, caption escaping and operand order; the existing ownerless-enum
UI refusal remains explicit. These are the plan's existing consumers, not full
Cloudflare tarball, browser, hosted or native-preparation qualification.

Implementation and validation stayed in the isolated worktree. Main then
fast-forwarded `7700621fa` to `22b66ab20`, preserving bytes/modes of its 47
pre-existing modified/untracked files and leaving foreign staging unchanged.
The living plan and DECISIONS reconcile all 13 incoming paths against retained
coverage; unchanged validation is reused. At that compiler checkpoint UI usage
and its joined completion were still unreleased; their later completion follows.
The complete review checkpoint and native-preparation **HUMAN HOLD** are unchanged.

## UI full-signature usage and finite join completion — 18 October 2026

The user released UI usage against `1255fc11f`. Values' existing AST walk is now
available as `messageUsages`/`MessageUsage`/`MessageUsageSite`; its own ValueError,
AST, validation and rendering contracts remain. UI's factory and formatting sink
both validate source and every present variant across every branch. Construction
checks declared types only; formatting retains locale then all supplied values
before syntax/usage. Type errors keep the existing UI messages, syntax errors keep
ordinary Error/JSON-pattern/UTF16 contracts, and rendering limits stay selected-only.

Validation covers **255 distinct TS tests**: initial 254 focused Values ICU/locale
and UI messages/usage/components tests passed, then an added inline-enum regression
and the affected UI scope passed 50 tests, reusing the unchanged 205 results.
Contracts/Values/UI emitted and typechecked. Independent source review covered the
factory/sink ordering, traversal, mapping, own keys and AST reuse. Both existing
named/anonymous formatter scripts pass with the unchanged frozen compiler producer
and current Values/UI output. The anonymous consumer exposed an inline-enum carrier
regression; reusing the type-ID parser for declaration checks corrected it, with
failure/pass evidence and a focused regression. The named non-enum result is reused.

Together with retained compiler checks (68 Rust tests, including the shared
63-case scalar-string corpus), these results satisfy the listed joined criteria
at the grammar/usage scope. No extra compiler rebuild or unchanged qualification
is required. Source-loaded Cloudflare, cached dependencies, Node24 transform-types
and the existing ownerless UI enum refusal retain their precise limits. These
checks do not certify full tarballs, browser/hosted/native delivery or complete
formatter parity.

Integration fast-forwarded main from `1255fc11f` to `8ad70d468`, covering the
five package and seven planning/decision paths recorded in the living plan.
Retain accumulated coverage, defining owners and target allocations. Newer
compiler/runtime source edits and foreign staging were preserved; concurrent
untracked database writes remain with their owner. No semantic integration edits
require renewed qualification. No canonical Rust task closure or complete
checkpoint advance occurs. Native preparation remains **HUMAN HOLD**.

## Optional single-Rust-parser follow-up

This is a **separate, dormant evaluation**, not a prerequisite or a second
implementation queue. Reconsider after consolidation if maintaining two
implementations causes concrete drift/cost, or an actual native consumer needs
the shared syntax output. Consistency can justify a port without a speedup, but
the total tradeoff must be explicit.

The candidate owner would be a small message-syntax module in the existing
Values `semantics` crate, consumed natively by compiler and through the existing
Values binding/delivery owners for TS. Keep type/disclosure/Intl/rendering outside.
Do not add a full ICU dependency or reopen the completed
[FormatJS 0.3.1 retain assessment](../../research/compiler-library-audit-20261006/pass9/icu/candidate-assessment.md).
That pinned result failed exact-selector/parse-time-depth gates; it is not a
claim about every future library version.

The finite evaluation compares this candidate against the then-shared TS parser
plus compiler implementation on the same corpus and real caller paths. Check:

1. Public synchronous calls without application-managed bootstrap; existing
   error/failure order; exact AST reconstruction, including bigint selectors.
2. JS UTF16 strings, lone surrogates and UI offsets. Existing JSON/UTF8 bindings
   do not by themselves establish this domain. Choose an exact boundary only
   if needed; do not invent a general text ABI in this planning task.
3. Required installed Node/Worker/UI consumer asset closure, cold startup,
   complete parse/validate/render cost, copies, allocation and shipped bytes.
   Compare both fresh patterns and repeated patterns; a parser-only timing does
   not choose adoption, and a cache is not assumed necessary.
4. Compiler diagnostic precedence/usage consumers and deletion of both replaced
   grammar implementations. No semantic-error retry through a second parser.

Stop with one **adopt / retain two implementations / defer for a named missing
consumer** decision, identifying any finite remaining delivery output. No
preordained speed threshold, broad native-host programme or automatic default
switch. Native preparation `P04–P11`/`C04.native-release` remains separately held.

## Advice, verification and remaining uncertainty

Three focused read-only source reviews covered Values, UI and compiler. Root
reconciled the profile against DESIGN, existing C09I acceptance, package
dependencies and current bindings. The [JEV consultation](icu-consultation.json)
contains three independently worded equivalent Choice requests over verified
public source facts. All chose staged TS sharing/compiler consolidation
(probability .96–.99) and literal outside-plural `#` (.79–.94). The third pound
answer left .17 on defer because the written rule was incomplete at investigation
time. The literal rule was an explicit proposal then; user approval, not model
agreement, now establishes the grammar decision.
No categorical disagreement required another consultation. Advice does not
establish correctness, performance or implementation permission.

The original investigation changed and executed no product code or tests;
its source matrix and historical C09I results retain their recorded pins. The
subsequent released TS implementation and focused checks are recorded above.
No performance or joined compiler/installed-host claim follows from those TS
checks. Compiler consolidation and UI full-signature usage are now separately
completed above, including finite joined validation at their selected scope.
A later shared Rust adoption remains dormant; native preparation remains held.
