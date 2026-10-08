# Syntax, stage coverage and recovery — audit Step 7

**The finite syntax map is reviewed; the independent-sibling recovery contract is
not satisfied.** Fresh controls demonstrate effects checks suppressed by an
unrelated malformed declaration, fabricated policy diagnostics and changed
source-language interpretation. Three accepted forms also lose authored meaning
without a compile error: tab captions/children, preference ordering and corpus
declarations. These are open compiler correctness findings, not successful
qualification of those workflows.

The single authoritative [coverage ledger](coverage.jsonl) adds 27 syntax-family
rows, eight finding/repair rows and their current source, witness and review joins.
[Complete production inventory](syntax-evidence/inventory.json),
[family/stage view](syntax-evidence/forms.json) and
[recovery trace](syntax-evidence/recovery.json) are supporting views.
All 186 named normative EBNF productions (including full multiline alternatives),
119 `SyntaxKind` variants and four `NodeDetail` variants are accounted for.
The 68 declared catalog words, 75 `HeaderKind` attribute-rule lines and 21 custom
key-form records have explicit admission/stage owners and limitations.
Abstract grammar notation, contextual alternatives and recovery carriers are
distinguished from executable forms. No unassigned production or kind remains.
This maps every finite form through subsequent ownership; it does not claim
independent execution of every grammar branch or attribute/value/context
cross-product.

Compiler source remains `1fd07722090fe70228a6b661e3c6e136275ca84b`; collection HEAD
was `f3dd798c`, followed by early audit commit `b2f22749`. All 107 compiler inputs
match Step 1. [Collection inputs](syntax-evidence/inputs.json) pin 119
compiler/corpus/catalog/contracts/allocation files; source, catalog and corpus
remain unchanged. The recorded DECISIONS prefix is historical context before the
isolated Step 7 append. [Runtime prerequisites](syntax-evidence/runtime-inputs.json)
pin 550 installed workspace files and package link destinations separately from
source/build parity. Economical Sol medium workers trace forms/recovery and
independently challenge the conclusions; Luna medium inventories and mechanically
validates facts. The same-day [researched allocation](../model-allocation-20261007.md)
is reused. No stronger worker setting or comparative model/cost measurement was
needed.

## Feature-to-stage coverage

The machine-readable rows contain exact defining symbols/ranges, admitted
production/kind assignments, stage status, actual consumer owners and remaining
gaps. A source reference is navigation; the row's limits determine its acceptance.

| Families | Checking and subsequent ownership |
| --- | --- |
| LEX, PATHS | UTF8/ASCII names, lexical values, layout and CST byte spans; contextual path/name rules; non-executable trivia and recovery carriers remain syntax-owned |
| OWNERS, CONTEXT, IMPORT | App/package/composition/context identity and import/export/deployment binding; resolved module imports reach IR module construction and package/artifact consumers |
| TYPES, FIELDS, RECORDS | Type atoms/unions/array/nullability, schemas/signatures/defaults/modifiers and model/contract/event/preference carriers; checked type/effect facts feed IR and descriptor/model consumers |
| METADATA, MESSAGES | Attached prose/references, inline/legacy descriptions, labels/source/variants and ICU slots; lexer decoding, metadata/type/example admission and typed IR/JS/reference consumers are distinct |
| EXPR, QUERY, DERIVE | Contextual primaries/operators/calls/member access/containers, query clauses and derived forms; checked facts reach expression/query IR; the frozen audit found Decimal emission gaps, and selected query paths remain bounded |
| GIVEN, RULES, FIXTURES, CAPABILITY | Roles, policies/invariants/unique/locks/retains, fixture recipes, capability operations and versions; semantic tables reach rules, defaults, descriptor and BDD consumers at their stated scope |
| OPERATIONS, STATEMENTS | CRUD/user/trusted operations, guards/do/effects/if/for/return/send/call/schedule and bindings; resolve/type/effect checks, handler IR and JS owners |
| TABLE_BDD, SEQUENCE_BDD | Example tables/imports/observations and sequence steps; examples checking, suite IR/BDD emission and actual testkit loader/table/sequence APIs; production of tests is distinct from platform execution |
| UI_CORE, UI_ORDER, ROUTES | Core/container/catalog/slot/preferences, captions/gates/selectors/order and route parameters; UI checking and IR factories/page descriptor consumers; wildcard/profile, tab and structured-order gaps remain open |
| CORPUS, JUDGMENT | Parser admission exceeds available semantic facts: Corpus can disappear silently; Judgment emits E6006 through its fieldless-contract carrier and is refused by CLI compile |
| MIGRATION | Maintenance/directives, selectors and predecessor identity reach IR-time migration checking, artifact metadata and separately owned runtime APIs; installed migration application is not established |

General source string interpolation has no grammar production. ICU interpolation
belongs to later message-pattern checking. `each=` is recovered with E1203; the
two draft exceptions are not supported fanout admission. Source query `limit` has
no production even though downstream IR contains a corresponding branch.
Prototype deferral prose and DESIGN's original “unimplemented” status do not
describe current Rust admission; the independent Python prototype has its own
bounded role.

### SYN-R08 maintenance update — 2026-10-08

The Decimal emission statement above and the Step 7 observations below describe
the pinned audit snapshot, not current behavior. Rust now lowers native Decimal
literals and contextual integral values through `parseDecimal`, and arithmetic
and value comparisons through the owning `Values` helpers. The permanent
[`decimal_runtime.rs`](../../../../compiler/tests/decimal_runtime.rs) test and
[`decimal-runtime` fixture](../../../../compiler/tests/fixtures/decimal-runtime/source.can)
cover those paths. Other permanent native-facade witnesses cover value equality
and membership, nullable and mixed numeric equality, text scalar ordering and
mixed numeric relations (including values above 2^53 and astral codepoints),
selected calls and binding/default/order paths, finite BDD fixture callbacks,
and string payloads. See
[`flat_expression_runtime.rs`](../../../../compiler/tests/flat_expression_runtime.rs),
[`selected_calls.rs`](../../../../compiler/tests/selected_calls.rs),
[`bdd_binding_runtime.rs`](../../../../compiler/tests/bdd_binding_runtime.rs), and
[`string_payload_runtime.rs`](../../../../compiler/tests/string_payload_runtime.rs).
These witnesses qualify named native callable/recorded profiles; they do not
establish full backend, transport, UI, host or all-source behavior. The Python
parser remains a separate syntax prototype with known corpus drift; its
historical 44-source count does not establish current syntax parity.

Broader hook/context and query-dependent profiles remain open, along with
protected forms and occurrence-specific error rerendering, BDD returned
payload/`as`/live behavior (BDD3), Task11 model-rule architecture, TECH-V05
timezone policy, and DEL-D05 native application/release profiles. The original
finding and execution receipts below are retained as historical evidence for
their pinned source and runtime.

## Executed witnesses

[Execution receipt](syntax-evidence/execution.json) captures a fresh
`cargo build --locked --offline --manifest-path compiler/Cargo.toml --lib --bin can`
and selects Cargo-reported rlibs for the audit observer. Native Rust/Cargo/Node
versions, command arguments/cwd, stdout/stderr/exits and library hashes are saved.
The observer uses the real catalog, `CatalogAnalyzer` owned result and production
`EmitOptions`; it never manually asserts complete analysis or emits through an
analysis-error gate.

- Eight focused suites (`syntax`, `b4_parse`, `analysis`, `check`, `effects`,
  `codegen`, `format`, `string_payload_runtime`): **330 harness passes, zero
  failures, no reported SKIP**. A separate `--lib syntax::` run adds **15 passes**.
  This is 345 selected passes, not the whole current suite or every optional branch.
- The real compiler/testkit fixture prints all six executed string witness lines.
  Defaults, metadata and example setup/observation closures retain independent
  controls/BMP/supplementary scalar expectations. App operations, full application
  admission and installed release are outside this fixture.
- [Forty initial cases](syntax-evidence/cases.json) use pre-execution independent
  sentinels. All 39 valid-UTF8 inputs retain complete CST coverage; invalid UTF8 is
  rejected by `lex_bytes` as E1002 at [12,13). The original 94 assertions have 81
  passes and 13 mismatches across eight cases, preserved as findings/boundaries.
- [Ten added controls](syntax-evidence/extra-cases.json) qualify policy/source
  metadata, tab/order/corpus/judgment through public stages. Fourteen actual CLI
  `check`/`compile` calls corroborate their results. Two more CLI byte-ingress calls
  reject malformed UTF8 as E7002/exit2 stderr tool errors, even with `--format=json`.
  This differs deliberately from the public lexer error. The initial capture
  mistakenly assumed JSON stdout for an early tool error; its output and capture
  correction are preserved in [byte admission](syntax-evidence/byte-cli-admission.json).
- [Post-observation outcome checks](syntax-evidence/outcome-verification.json)
  add independent E1 rejection, Unicode byte anchors, exact default/description
  values, raw owner prose and clean-result emission assertions after reviewer
  challenge: **76 checks, 69 passes, seven intentional defect mismatches**. These
  are explicitly later assertions, not claimed as pre-execution expectations.
  Tab checks inspect executable JS, excluding source-map `sourcesContent`.
- [Fresh corpus stage replay](syntax-evidence/corpus-observations.json) covers all
  54 pinned files: 54 full byte coverage, 52 parse-clean, two check-clean; emission
  is attempted only for those two. ExpenseFlow has no emission diagnostic;
  TeamTasks reports two E6008s. The two parse failures retain their known
  two-E1203 draft profiles. The corpus contains 107 of 119 kinds; it is not a
  witness for the other 12. Corpus output is a diagnostic/state projection with
  raw stdout hashes, not retained complete JS/artifacts, and no corpus JS executes.

Existing tests mix exact independently stated values, source/design-derived
expectations, hermetic catalogs, golden emitted strings and corpus inputs. Their
passing status does not turn synthetic/incomplete codegen goldens into runtime
acceptance. All relevant source/catalog/corpus and recorded runtime pins were
checked unchanged after execution. This host is macOS arm64 only.

## Findings and bounded repair packets

The landed resolver/header recovery fix `4ecd991a` is retained and freshly covered.
Closed malformed declarations, bad Unicode/code characters, invalid units,
unknown/lone-surrogate escapes, bad description references/indentation and
mismatched closers preserve E3002 at `1 + true` and E2001 at `nope`. CRLF and final
implicit newline variants also pass. ICU E5007 survives a malformed sibling.
These successes do not cover the residual per-pass gates below.

| ID / priority | Demonstrated outcome and exact writer | Required outcome / allocation |
| --- | --- | --- |
| SYN-R01 / high | `analysis/effects.rs`: recursive owner gate drops E4011 in an intact scenario; recursive File gate drops E4020 even in a second valid module. Dropped model policy tables also invent E4004 despite a valid policy. | Analyze independent valid declarations/positions and keep local dependent suppression. Retire owner/File-wide vetoes at these boundaries; preserve false/missing finding controls, tables and CLI/IDE reporting. Sol medium, one effects writer; focused analysis/effect/process regressions. |
| SYN-R02 / high | `analysis/types.rs::collect_module_sources`: unrelated malformed policy drops valid `source="fr"`; real fr-variant E3016 disappears and valid en variant gains false source-en E3016. | Valid owner header metadata stays authoritative while siblings recover. Retire the recursive body veto for valid source metadata; preserve malformed-header local suppression. Sol low after this exact contract release; independent Sol medium review. Locale-parser/alias policy stays separate. |
| SYN-R03 / high | `codegen/ir.rs::decode_ui` fallback emits `tab({context:c})`; authored caption and nested text vanish. CLI check/compile both exit0. | Preserve supported Tab caption/child ownership through IR and actual UI factory/consumer, or fail explicitly if a required supported boundary is absent. Sol medium; shared IR writer; exact emitted and consumer witnesses. |
| SYN-R04 / high | `codegen/ir.rs::decode_collection` sends PreferenceOrder to `selector_strings` fallback; nonempty by/default/cases becomes `order:[]`; CLI exits0. | Preserve the authored structured policy through the owning UI/runtime profile. Retire the unsupported-node-to-empty shortcut at this boundary. Sol medium; serialized with R03 on IR; no new ordering policy chosen here. |
| SYN-R05 / high boundary | Corpus attributes, including unknown `Missing` model, are not checked/indexed/lowered; CLI check/compile exit0 with no corpus. Judgment checks clean but compile refuses E6006. | Corpus must have checked ownership and retained meaning or explicit unsupported admission; no clean silent disappearance. Release corpus/judgment support separately with exact resolver/type/effect/IR/artifact owners and language acceptance. Sol medium; consequential new support alternatives require verified-context JEV. Judgment is fail-closed, not silently shipping. |
| SYN-R06 / gated recovery | `syntax/layout.rs` joins an unclosed schema/call/list through EOF; an unterminated string inside an open schema has the same effect. Valid derive lines and even a later top-level module are swallowed while coverage passes. | Decide synchronization witnesses against legitimate multiline delimiters and nested layout before changing joining. Sol medium; high only for unresolved policy. Verified-context JEV for consequential alternatives; no ad hoc authority parser or unconditional indentation split. |
| SYN-R07 / next admission packet | Generic UI accepts arbitrary words/attributes; mystery component checks clean then emits E6008. Only 20/68 catalog words directly match the JS factory whitelist after spelling adaptation; this is availability, not complete profiles. | Qualify finite component/option/header/child profiles with actual owners. Known unavailable forms must report clearly; adding factory words alone cannot complete semantics. Sol medium; parser/types/IR/JS writers and producer profile release coordinated. Preserve fail-closed emission. |
| SYN-R08 / maintenance and witnesses (historical finding at pinned audit source) | At the pinned Step 7 source, Decimal expressions were checked but emitted E6008; other partial families/consumer joins and prototype prose had explicit gaps. Green source goldens did not prove execution. | Maintenance update above reconciles the landed Decimal and named runtime witnesses with current prose. Remaining partial families and consumer joins retain their stated gaps; this historical row does not claim their completion. |

SYN-R01 and R02 are independent of delimiter policy and new language features.
R03/R04 share the IR writer and must serialize. R05/R07 require released owner
boundaries; unresolved support blocks that packet, not independent correctness
repairs. Repair acceptance is about restored outcomes and retired masking/loss
mechanisms, with the existing complete-closure production-reduction goal still
binding. No large compatibility or secondary recovery engine is proposed.

## Review and limits

[Independent Sol review](syntax-evidence/cross-review.json) records its own
source/raw-outcome trace before consulting the primary conclusions, then verifies
corrected full grammar ranges, actual import owners, custom key scopes, negative
admission and positive artifact assertions. [Luna checks](syntax-evidence/validation-luna.json)
validate finite inventories, ranges, source/corpus hashes and links;
[integrated validation](syntax-validation.json) validates the extended shared
ledger and final evidence. Source mapping, executed evidence, independent review
and proposed writer/allocation are separate dimensions. Complete finite mapping
and bounded execution/review are accepted; whole semantic/oracle/resource/host
and installed/original-app qualification remain open.

No compiler, package, dependency, public API, grammar or policy implementation is
changed. These fixtures are saved audit regression candidates; promotion is part
of their repair packet. No JEV decision was needed to expose existing contract
violations; new consequential synchronization/support alternatives remain gated.
Whole compiler production remains 69,255 versus original 69,119 (+136), with zero
Step 7 production change. No merge or living-plan checkpoint advancement occurs.
