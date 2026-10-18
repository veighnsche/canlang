# Bounded ICU grammar and shared-parser plan

**18 October 2026 · approved grammar profile; TS sharing and compiler consolidation complete.**
The source investigation below retains its historical baseline at
`0bb480bef36b8a4aa9dafd932a06443f5543d33c` (inspected product files unchanged from
`08dc8c392`). The user approved the grammar profile, then separately released
Shared TS syntax and compiler parse/usage consolidation for
[package-audit candidate 1](README.md#1-shared-bounded-message-syntax--strongest-semantic-consistency-opportunity).
Both packets are complete at their recorded scopes. UI full-signature usage
remains unreleased; joined completion remains pending. Native preparation remains
**HUMAN HOLD**.

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
| Values | [`src/icu-syntax.ts`](../../../packages/values/src/icu-syntax.ts): shared syntax/normalization/diagnostics; [`src/icu.ts`](../../../packages/values/src/icu.ts): public `parseMessageFormat`, `validateMessagePattern`, descriptors and rendering; root exports in `src/index.ts` | Public AST/node shapes and exact bigint selectors; `ValueError`; own-key binding checks; numeric admission; locale/Intl and formatting |
| UI | [`src/messages.ts`](../../../packages/ui/src/messages.ts): shared Values syntax consumer; `message`, `formatMessageResult`, captions/components; former private parser removed | Contracts descriptors, optional owning `sourceLocale`, resolved type IDs/native operands, public error family, locale selection, exact rendering, HTML escaping and `lang`/direction |
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

UI still converts every supplied operand, then validates usage only while
rendering the selected branch in `formatMessageResult`/`renderArgument`. Thus
`{s,select,a{ok} other{{missing}}}` with `s="a"` succeeds. Values checks all
branches before rendering. UI `message()` also leaves source/variant syntax
unchecked. These are separate full-signature gaps under DESIGN, not evidence
that importing an AST alone completes the task.

Propose a separate finite UI usage join: validate syntax and declared usage in
source and every present variant, including unselected branches, while keeping
actual rendering on the selected locale/branch. Reuse the shared parse output
for usage; do not introduce another scanner. The factory may check grammar and
type declarations after its existing metadata/wrapper checks without converting
operand values. A formatting call receiving a structural descriptor must also
perform the checks after its existing locale and eager supplied-value admission;
do not rely on factory branding. Within that call parse each needed pattern once.
Earlier factory rejection of malformed/unbound variants is an explicit proposed
change. Literal captions and already resolved text are never reparsed as ICU.
Keep unbound factory use valid: when `params` is absent, construction checks
syntax only and binding waits for formatting. At formatting, the effective
signature remains `options.args ?? descriptor.params`; explicit arguments keep
their existing override behavior. Do not impose Values' constructor-specific
reserved-name policy on UI merely because the parser is shared.

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

The grammar profile is approved. Shared TS syntax and compiler consolidation are
released and complete at the scopes recorded below. UI full-signature usage and
joined completion remain **proposed, unreleased**. Any later
packet requires its own release and named producer output; it does not wait for
whole A/V/W programmes.

| Packet / existing scope | Defining owner and concrete prerequisite | Remaining change and observable acceptance |
| --- | --- | --- |
| Profile and witness decision — candidate 1; existing `I-POUND-POLICY` | Language/Values + Compiler/UI; this matrix, owner tests and existing C09I cases | **Grammar profile approved**, including literal outside-plural `#` and the listed lexical changes. TS and compiler implementation were separately released; UI full-signature behavior remains proposed. |
| Shared TS syntax — candidate 1 | Values writer then UI writer; approved profile/change list | **Released and complete.** Values owns shared syntax/selector normalization and narrow diagnostics; its existing wrapper preserves ValueError/AST behavior. UI consumes the AST in its own renderer; `PatternParser` and `PatternNode` are removed. Approved grammar, UI offset projection, nearest `#` and existing message/caption consumers pass as recorded below. |
| One compiler parse/usage owner — existing C09I `I-COVERAGE`, `I-TAGS`, `I-PLURAL`, `I-SELECT`, `I-DEPTH`, `I-EXACT-LEXICAL`, `I-POUND-POLICY` | Compiler; approved profile/cases, existing IcuType mapping and current anonymous-schema outputs | **Released and complete.** Private `analysis/icu.rs` owns syntax and ordered valid-pattern usages. All listed consumers share it; the permissive slot walkers and old examples parser are removed. Narrow declaration/type callbacks preserve the original checkpoints, whole authored-literal spans and malformed recovery. Original finite criteria and named/anonymous formatter consumers pass below. Accepted `I-TYPE` stays a regression check. |
| UI full-signature usage — existing candidate 1 / DESIGN §9.1 consumer obligation | UI with Values usage producer; shared TS syntax result and type-only usage traversal available | Add the source/present-variant and all-branch checks described above using UI's existing type-ID mapping and operand adapter. Missing/invalid usage in an unselected branch/variant refuses; valid differing branch schemas, native operands and resolved text retain their contracts. No duplicate parsing in one formatting call; no new descriptor carrier. |
| Joined completion — consumes the three outputs above | Values/UI/Compiler owners; exact changed producer closure | Run shared cases through actual public TS entries and compiler checks; one existing compiled-to-installed UI/formatter consumer covers anonymous/named messages and fallback. Verify unchanged literal captions, own-key handling, exact large/fractional branch selection, offsets and dual-fault ordering. Credit each outcome once; do not replay unrelated locale, numeric or full compiler qualification. Stop when selected grammar/usage scopes pass and duplicate parsers/scanners are removed. |

The completed TS and compiler packets share the approved profile and cases.
UI usage can consume the TS syntax result
but remains unreleased; joined completion waits only for its named outputs. One
Values writer owns syntax/usage/export edits; one Compiler writer owns
`examples.rs`/`types.rs` integration. No heavy cache, native
preparation slot, installer programme or additional worktree is allocated here.

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

- Values keeps `src/icu.ts` for public wrappers, descriptor/usage/formatting;
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
Descriptors, operand admission and selected-branch usage remain unchanged apart
from the approved grammar changes. Full-signature/all-branch/all-variant usage is
still a separate unreleased packet.

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

No newer compiler/runtime source in the main checkout was edited; implementation
and validation stayed in this isolated worktree. UI full-signature usage and its
joined completion remain unreleased. No merge or complete checkpoint advance
occurs here; native preparation remains **HUMAN HOLD**.

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
checks. Compiler consolidation is now separately completed above. UI
full-signature usage and any later shared Rust adoption remain proposals;
native preparation remains held.
