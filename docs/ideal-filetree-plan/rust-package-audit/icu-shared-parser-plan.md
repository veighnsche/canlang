# Bounded ICU grammar and shared-parser proposal

**18 October 2026 · proposal only · source `0bb480bef36b8a4aa9dafd932a06443f5543d33c`.**
The inspected product files are unchanged from `08dc8c392`. This completes the
first contract investigation for [package-audit candidate 1](README.md#1-shared-bounded-message-syntax--strongest-semantic-consistency-opportunity).
It does not release implementation, change the language specification or advance
the complete filetree checkpoint. Native preparation remains **HUMAN HOLD**.

**Recommendation:** use the existing Values grammar as the explicitly documented
baseline, share its TS parser with UI, and consolidate compiler syntax and
placeholder discovery into one Rust parser. Retain two implementations of one
profile initially. Consider one Rust implementation serving all three only in
the bounded follow-up below; do not require Wasm to call today's synchronous
public TS parser as an incidental refactor.

The [Rust start guide](../../implementation/RUST-PORT-START-HERE.md#current-execution-view--2026-10-18)
remains the single execution view. Steps below are finite proposed subdivisions
of this candidate, with links to existing compiler correctness packets, not new
canonical task IDs or a second dispatch queue. Existing A/V/W/C04 readiness and
accepted components are unchanged.

## Contract and current owners

[DESIGN §9.1](../../specification/DESIGN.md#91-built-in-internationalization)
requires one bounded profile: named placeholders, number/integer, date/time,
nested plural/selectordinal/select with mandatory `other`, exact numeric cases,
apostrophe-friendly quoting and full signature checks. It excludes offsets,
choice, custom/skeleton styles and rich-tag handlers. It does not spell out every
lexical rule, outside-plural `#`, or the depth-counting unit. Those are explicit
proposal choices below, not already accepted language changes.

| Owner | Actual entry and responsibility | Preserve at the adapter boundary |
| --- | --- | --- |
| Values | [`src/icu.ts`](../../../packages/values/src/icu.ts): public `parseMessageFormat`, `validateMessagePattern`, descriptor construction and rendering; root export in `src/index.ts` | Public AST/node shapes and exact bigint selectors; `ValueError`; own-key binding checks; numeric admission; locale/Intl and formatting |
| UI | [`src/messages.ts`](../../../packages/ui/src/messages.ts): private `PatternParser`; `message`, `formatMessageResult`, captions/components | Contracts descriptors, optional owning `sourceLocale`, resolved type IDs/native operands, public error family, locale selection, exact rendering, HTML escaping and `lang`/direction |
| Compiler | [`analysis/examples.rs`](../../../compiler/src/analysis/examples.rs): `IcuParser`/`icu_error`/static caption checking; [`analysis/types.rs`](../../../compiler/src/analysis/types.rs): `message_slots` and its scanners | Source signatures, explicit binding, disclosure/provenance, source/variant ownership, diagnostic codes/order and whole authored-literal spans |

UI already imports and depends on Values; Values depends on Contracts, so parser
reuse adds no package cycle. Compiler already depends on `values-semantics` for
other work; a later shared Rust core would not inherently require another crate.
Neither fact supplies the missing cross-language parser transport or adoption.

## Grammar differences and proposed disposition

These are **source-derived witnesses**, not newly executed tests. Values parser
rules are at `icu.ts:240–557`; UI at `messages.ts:382–605`; compiler at
`examples.rs:3295–3580`. Use explicit declarations of the named operands when
checking compiler syntax so undeclared-name diagnostics do not obscure the case.

| Case | Values now | UI now | Compiler ICU checker now | Proposed common grammar |
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
| Exact `=-1`, `=+1` | Reject both | Accept both | Accept minus, reject plus | Retain unsigned `digits(.digits)?` for this proposal. Negative operand values remain valid; signed selector syntax is a separate possible language extension. |
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
No Unicode normalization or case folding is proposed. Literal text, including
supplementary characters, is retained. Values/UI accept JS strings containing
lone surrogate code units; a future Rust boundary must preserve them or obtain
an explicit public-domain change, not silently replace them during UTF8 conversion.

The baseline is a compatibility choice, not a claim that Values defines all
language policy by accident. It avoids taking the union of permissive dialects
or adding full ICU syntax. The intended changes are exactly the differing rows
above, plus the usage/diagnostic dispositions below. Existing all-agree behavior
and unrelated numeric/locale behavior remain outside the change.

## Usage discovery is part of the finite consolidation

The compiler's earlier coverage pass is another grammar implementation, not just
a list operation. `types.rs:11922–12040` differs from its ICU checker:

- `Don't {ghost}` is hidden by the scanner's quote-to-next-apostrophe rule;
  `{ ghost }` misses the placeholder because it does not skip leading space.
- A spaced typed head can fall back to flat scanning. Negative exact keys can
  abandon branch scanning and mistake a branch body such as `{one}` for an
  argument. Unicode/digit-start names can produce coverage noise before the
  stricter ICU checker rejects the grammar.
- For valid patterns, derive names and usage kinds from the same parser that
  validates syntax. Retain source order and all branches; selectors, quoted
  text and branch prose are not arguments. For malformed patterns, propose
  suppressing speculative slot extraction and leave the failure to the existing
  E5007 checker. The removal of malformed-input E3016/E3013 noise is an explicit
  diagnostic change, not an unnoticed consequence of extraction.

The compiler consumer list is finite: named source/present variants; explicitly
bound anonymous descriptors; selected raw format leaves through checked
aliases/choices; remaining inline structural checks; static contributed-field
captions; and the four `message_slots` call sites (`types.rs:6363,6434,9269,19434`)
for general coverage, page context-free checks and anonymous binding unions.
Anonymous typed schemas already reach `IcuParser` (`examples.rs:293–316`);
historical Pass9 wording that all anonymous descriptors are structural-only is
no longer current. Keep plain `scan_format_template` for the separate machine
template overload outside this migration.

UI currently converts every supplied operand, then validates usage only while
rendering the selected branch (`messages.ts:873–1019`). Thus
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

The profile review below is decision-ready now. Implementation packets require
an explicit release of this proposal and their named producer output; they do
not wait for whole A/V/W programmes. All are currently **proposed, not dispatched**.

| Packet / existing scope | Defining owner and concrete prerequisite | Remaining change and observable acceptance |
| --- | --- | --- |
| Profile and witness decision — candidate 1; existing `I-POUND-POLICY` | Language/Values + Compiler/UI; this matrix, current owner tests and existing C09I cases | Accept or amend the exact lexical and malformed-diagnostic rows, including literal `#`, and the intentional UI usage changes. Output one approved profile/change list. Stop when every row has an outcome; no new broad ICU completeness requirement. |
| Shared TS syntax — candidate 1 | Values writer then UI writer; approved profile/change list | Factor syntax/selector normalization and narrow diagnostics behind Values' existing parser wrapper. UI consumes that AST in its own renderer; delete `PatternParser` and redundant `PatternNode` grammar. Existing UI → Values dependency suffices. Done when approved grammar cases, unchanged ValueError/AST behavior, UI offset projection, nearest `#` and existing message/caption consumers pass. No Values-renderer substitution. |
| One compiler parse/usage owner — existing C09I `I-COVERAGE`, `I-TAGS`, `I-PLURAL`, `I-SELECT`, `I-DEPTH`, `I-EXACT-LEXICAL`, `I-POUND-POLICY` | Compiler; approved profile/cases, existing IcuType mapping and current anonymous-schema outputs | Consolidate the scanner under a private analysis ICU module; all listed consumers use its grammar and valid-pattern usage result. Preserve typed diagnostic checkpoints via a small compiler-owned validation hook at the existing parse points; avoid a generic event/transport framework. Remove old permissive slot walkers and apply only the selected corrections. Done when all listed consumers and original finite packet boundaries pass, including escaped-literal spans, source/variant order and malformed recovery. Already accepted `I-TYPE` is a regression check, not reopened work. |
| UI full-signature usage — existing candidate 1 / DESIGN §9.1 consumer obligation | UI with Values usage producer; shared TS syntax result and type-only usage traversal available | Add the source/present-variant and all-branch checks described above using UI's existing type-ID mapping and operand adapter. Missing/invalid usage in an unselected branch/variant refuses; valid differing branch schemas, native operands and resolved text retain their contracts. No duplicate parsing in one formatting call; no new descriptor carrier. |
| Joined completion — consumes the three outputs above | Values/UI/Compiler owners; exact changed producer closure | Run shared cases through actual public TS entries and compiler checks; one existing compiled-to-installed UI/formatter consumer covers anonymous/named messages and fallback. Verify unchanged literal captions, own-key handling, exact large/fractional branch selection, offsets and dual-fault ordering. Credit each outcome once; do not replay unrelated locale, numeric or full compiler qualification. Stop when selected grammar/usage scopes pass and duplicate parsers/scanners are removed. |

The TS and compiler packets can proceed independently after the profile and
shared cases are fixed. UI usage consumes the TS result; the joined check waits
only for those outputs. One Values writer owns syntax/usage/export edits; one
Compiler writer owns `examples.rs`/`types.rs` integration. No heavy cache, native
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
UI's message suite currently has no own-key binding regression, so add only the
missing own-versus-inherited binding cases at the affected usage boundary.

Proposed file allocation is deliberately small:

- Values keeps `src/icu.ts` for public wrappers, descriptor/usage/formatting;
  a private `src/icu-syntax.ts` would own syntax and diagnostic data, with only
  the narrow package export UI actually needs. Keep existing exports compatible.
- UI keeps its descriptor/resolver/renderer in `src/messages.ts`; it consumes
  Values nodes and diagnostics rather than importing Values rendering.
- Compiler owns a private `src/analysis/icu.rs` for its one native grammar/usage
  implementation and validation checkpoints, used by `examples.rs`/`types.rs`.
  No new crate or product dependency is needed for this stage.
- One plain data corpus, proposed at `packages/values/test/fixtures/icu-profile.json`,
  carries syntax/usage cases for TS and Rust tests. Extend existing owner suites
  for host errors/rendering; do not create a parallel verification framework or
  duplicate the corpus per consumer. Existing C09I cases remain the baseline.

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
answer leaves .17 on defer: the written rule is incomplete, so the literal rule
remains an explicit proposed policy, not authority inferred from model agreement.
No categorical disagreement required another consultation. Advice does not
establish correctness, performance or implementation permission.

No product code, tests, dependencies, generated assets or default routing were
changed or executed for this investigation. Historical executed C09I results
remain evidence at their recorded pins; this matrix is a current source reading.
New performance/installed-host results are not claimed. Documentation checks
cover local destinations, consultation JSON and whitespace. Grammar approval,
the intentional diagnostic/usage changes and any later Rust adoption remain
proposals; the completed output here is this finite plan.
