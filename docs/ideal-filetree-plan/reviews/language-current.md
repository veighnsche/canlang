# Language, authoring, development ownership and native Values

Planning review at `1c3f1b383ad3eb02052f8240c9f6749134210f4c` in `/home/vince/Projects/canlang`. Primary: `audit_language`. Independent challenger: `audit_platform`. This record changes documentation only; no build, product test, service, Git mutation, installation, provider call or implementation was performed by this audit.

## Scope and evidence

The assigned path catalogue contains 731 tracked paths: compiler 497, native development server 51, editor 58, Values 118 and tools 7. Values' TypeScript public codecs and host bindings are runtime-review duties; this review owns their native semantics, WASM exports, generated assets and compiler/build joins. All listed paths receive retained ownership in the shared inventory; that inventory is path accountability, not a claim of exhaustive correctness inspection.

Fresh inspection read manifests, module roots, source/symbol families, current CLI compilation and saved-unit paths, source-context construction and semantic joins, source-stage SEND lowering, LSP framing/currentness, development session/preview/bridge ownership, native Values entrypoints and generated-asset staging. The size scan used 800 lines as an inspection prompt for authored text, not a mandatory split. Conformance vectors, locks, licenses and generated assets were classified as data/producer outputs; their length is not a split justification. Large checker, emitter and receipt files were mapped by responsibilities and selected actual functions rather than treated as one homogeneous compiler duty.

The older [compiler review](compiler.md) names source `350163ad...`, a different checkout and 394 paths across a different assignment. It remains historical reasoning, not a current whole-source verdict. Current instructions supersede its process claims. Existing fixtures and the prior 91 Rust/overdue integration results reported in the implementation conversation are bounded earlier behavioral evidence at the exercised code; this source-only audit does not rerun them or extend them to all compiler, editor or dev-server workflows.

| Slice | Responsibilities | Established source workflows | Independent challenge | Exact allocation |
| --- | --- | --- | --- | --- |
| L01 syntax, names, typing, effects and diagnostics | Full path catalogue; major pass/field duties inspected; individual branches and all fixture expectations not exhaustively rereviewed | Parse → resolve → types → effects → examples → ordered diagnostics traced; remaining checker families retain explicit later review gates | Platform challenged parser/prototype equivalence and existing editor constraints | Every current path retained; grammar synchronization packet is exact; broad checker decomposition is not selected |
| L02 IR, source correspondence, lowering and artifacts | Major mixed owners, source proof context, guarded SEND and private prepared inventories inspected | CLI immutable source/catalog → CheckedProgram → IR → fresh original correspondence → prepared emission → artifact/BDD/source maps traced; not every legacy app decision profile requalified | Platform challenged one constructor, borrowing/caches and nongrant metadata distinction; accepted below | Exact private context/correspondence extraction; all other codegen leaves retained; named profiles require individual semantic migrations |
| L03 CLI, LSP, editor and syntax prototype | Actual entrypoints, manifests, framing/currentness and saved-generation import closure inspected; visual assets catalogued only | Check/compile, source-preserving generation joins, LSP full-document/currentness and editor startup/disposal traced at source; no editor host/install run | Standard client and Python retirement alternatives examined with platform | Exact CLI private command targets; editor/prototype retained; grammar correction gates syntax-only claims |
| L04 development session and preview lifecycle | Public session owner, worker facts, fixed SDK bridge, preview preflight and cleanup ownership inspected; all browser-test branches not exhaustively rereviewed | Session claim → captured input → check ticket → compile/preflight → native-selected preview → capability-protected gateway → disposal/failure retention traced | Node-only owner alternative challenged against actual generation/claim authority | Exact complete worker extraction; owner loop, resource and state authority stay native; no process added |
| L05 native Values semantics and generated bindings | Native module/export and asset producer/consumer catalogue complete; representative numeric/validation/transport duties inspected | Compiler direct dependency and opt-in TS → bounded WASM ABI → native exact operation → encoded result → typed TS error bridge; normal build verifies/stages committed assets | Runtime challenger requested preservation of host/projection boundaries; TS-only alternative considered below | All native sources and generated leaves retained; no broad port; currency-mirror correction remains gated on diagnostic equivalence |

These statuses distinguish complete catalog/allocation from partial substantive review. No claim is made that all 731 bodies, every built-in domain or every test assertion has received a fresh end-to-end semantic review. The task list must retain that remaining review as a gate on new correctness or retirement conclusions; it does not block the exact source-only mechanical placements below.

## Intended model and authority

The governing sources are [requirements](../../specification/REQUIREMENTS.md), [design](../../specification/DESIGN.md), [grammar](../../specification/GRAMMAR.md), root AGENTS and the user's current request to simplify shared mechanisms while preserving permissions. The latest implementation explicitly preserves overdue's original staged decision through `when_at=source`; ordinary/current `when` remains a live dispatch check. Filesystem/module names are not business or model identity.

The compiler library owns one syntax and semantic chain. `analysis/mod.rs` identifies source nodes by physical file/start/end/kind, ties `CheckedProgram` to source/catalog ownership, and explicitly says editable public tables are not proof of correctness. `codegen/mod.rs::emit` refuses foreign cohorts and incomplete/shipping-error inputs. Fresh original correspondence and prepared inventories remain separate from editable IR and optional observer metadata.

The native development server owns session claims, current generation, capture/check tickets, cleanup and publication. Node owns only the fixed SDK/browser adapters that require that host. A worker reporting a successful compilation or a readiness-looking log does not select or publish a generation. Work cancellation and cleanup failure retain ownership rather than silently freeing resources.

Values owns exact numeric/temporal representations and transport validation; compiler checking may consume that owner but may not invent a second permanent value semantics. JS-only timezone/Intl behavior remains a host boundary, not a reason to assert Rust/WASM parity for unsupported domains.

## Source responsibility map and selected destinations

Every current leaf not named for a successor below stays at its exact current path. Its source/module shell, imports, globals, private state, error types and remaining functions stay with that retained owner. No complete file or duty is implicitly discarded. The shared inventory supplies the exhaustive leaf list; this table specifies mixed-duty cutovers, not another competing path ledger.

| Current defining unit | Responsibility | Selected destination and caller joins |
| --- | --- | --- |
| `compiler/src/syntax/{lexer,layout,cst,parser}.rs` | Physical source/layout, rollback-aware syntax and located parse failures | Retain. The new SEND qualifier needs normative grammar and syntax-prototype/editor comparison, not a second parser rewrite |
| `compiler/src/analysis/{resolve,types,effects,examples}.rs` | Name ownership; typed source and narrowing; effect/handler declarations; independently authored fixture/example expectations | Retain private pass contexts and current files. `types.rs` includes distinct declarations, expression/query/callback/UI typing, narrowing, literal admission and saved Given contracts; those are separate review duties, not an approved indiscriminate file split |
| `analysis/scenario_disclosure.rs` | Checked source requirements for controls, DATA/result dependencies, calls, branches, loops, event inputs and original source inventories | Retain. It is 29,288 lines, but its facts cannot be replaced by runtime recipe guesses. Later extraction requires a complete fact/consumer map and independent preservation of control versus DATA authority |
| `codegen/ir.rs` | Typed IR declarations, lowering Cx, UI/value/source provenance, Given/Then joins and producer descriptors | Retain. Public IR and private sealed provenance have different duties; do not export a purported proof DTO simply to move code |
| `codegen/js.rs` | Public emitted DTOs/serialization, module writer/source maps, expression/effect/UI emission, checked source-effect collection and saved Then composition | Retain. `SourceWorkCollector` already shares Schedule/Cancel; `Reads`/source environment already shares DATA serialization. Do not reintroduce app-specific copies while extracting commands |
| `codegen/scenario_receipts.rs` | Receipt plan shapes and capture/return/query/model-source correspondence, source-created records and ordered effect proofs | Retain current leaf. It is not the runtime State session owner and moving it into State would invert source semantic ownership |
| `codegen/scenario_decisions.rs::FreshSourceContext`, `SourcePreparationGap`, complete preparation/accessor/semantic-cache impl | One invocation-local immutable checked original/current IR/source cohort and cached comparison | `compiler/src/codegen/source_context.rs`. Preserve one private constructor, owner borrowing and cache. Add one module declaration in `codegen/mod.rs`; change real private imports together or use a temporary internal reexport with one defining implementation |
| Same file: `SemanticJoin`, complete impl; `check_owner_identity`, `join_scenario_lists`, `join_semantic_params`, `same_scenario_semantics`, `same_capability_operation`, `known_type_equal` | Structural semantic comparison including explicit SEND phase, trigger, argument/default and callee/schema correspondence | `compiler/src/codegen/source_correspondence.rs`. Keep source_context as caller/owner of original context. No new crate, host port or authority-bearing serialized claim |
| Remainder of `scenario_decisions.rs` | Decision/source DTOs, source-site requirements, optional observation collectors and serializers | Retain original file and existing public observer API. Optional `serialize_decision_sources` is nongrant transport; its narrower schema/header checks are not a new execution capability |
| `cli.rs::ParsedArgs`, `parse_simple_flag`, `parse_root_settings_flag`, `parse_path_valued_flag`, `parse_valued_flag`, `parse_args`, `parse_format`, `check_flag_scope`, `check_docs_flag_scope` | Parsing and validating command flags and operand modes | `compiler/src/cli/args.rs`; all dispatch callers use the same type/defaults. Keep helpers visible only as required by the parent module |
| `cli.rs::read_source_file`, `read_source_text`, `add_source`, `run_check_like`, `run_compile`, `frozen_source_db`, `compile_saved_roots`, `GivenJoin`, `prepare_saved_given`, `join_saved_given`, `given_saved_unit`, `attach_saved_given`, `attach_saved_then` | Complete analysis/compile orchestration and pinned saved-unit production joins | `compiler/src/cli/compile.rs`; preserve original SourceDb/catalog identity, error ordering, native flag and no-artifact-on-error behavior. Saved generation readers remain defined once, imported from generation owner where shared |
| `cli.rs::run_policy`, `run_docs`, `run_docs_with_platform`, `docs_out_refusal`, `render_via_platform`, `read_renderer_pipe`, `stderr_tail` | Checked policy/reference products and fixed-argv renderer protocol | `compiler/src/cli/reference.rs`; shared executable locators stay in parent cli rather than copied into reference/entry/generation |
| `cli.rs::run_gen*`, `Gen*`, `Bind*`, `Saved*`, saved declaration/file validation, JS scan/admission/import-closure helpers, `admit_*` generation transitions | Saved generation discovery, lease/accept/refine/reset lifecycle, complete local import custody and independent validation | `compiler/src/cli/generation.rs`; preserve fixed relative import admission, no bare/Node/file/require edges, complete closure fingerprint and existing store/lease owner. The enclosing source range is approximately 2822–7788; use full symbol selectors, not a blind line cut |
| `cli.rs::run_source_entry`, `run_thin_entry`, `run_dev_entry` | Fixed compiler-facing host/development command delegation | `compiler/src/cli/entry.rs`; preserve `can`/`can-dev`, environment overrides, exit/stdout/stderr contracts and installed same-release lookup |
| Remaining cli module shell, Analyzer/OwnedAnalysis/DispatchResult/public `run`/dispatch routes, help/explain/format/lint/atomic replacement and shared locators | Public stable command facade and remaining editing/IO duties | Retain `compiler/src/cli.rs`. No test-only Analyzer becomes production default and no user-facing command is renamed |
| `compiler/src/{lsp,ide,lint,format,source,diagnostic,json,...}` and public lib/main | Shared authoring model, version/currentness, physical/UTF-16 conversion, safe edits and diagnostic envelopes | Retain existing leaves. Custom JSON-RPC framing and typed `lsp-types` output are distinct; replacing one does not prove equivalent source locations/rename behavior |
| `dev-server/src/owner.rs::CheckWorker` plus complete impl | Worker capture/check/compile/stage facts sent to serialized owner loop | `dev-server/src/owner/check_worker.rs`; no generation selection/publication moves with it; `Event`, ticket and resource lifecycle stay owner-defined |
| Same file `ServiceWorker` plus complete impl | Worker execution of fixed service/control requests and retained facts | `dev-server/src/owner/service_worker.rs`; root Loop still owns currentness, response routing and cleanup retention |
| Remaining owner shell, `Owner`, `Config`, `Event`, `Loop`, `Generation`, retained/check/service/recipe/index state and other helpers | Single development-session and generation authority | Retain `dev-server/src/owner.rs`; worker module visibility must not create another controller or independently mutated copy of the maps |
| `dev-server/src/preview.rs` and existing `preview/{bindings,bundle,http,runtime,state}.rs` | Artifact byte correspondence, native binding/preflight, identity/seed/storage activation, gateway probing and isolated browser/test setup | Retain existing split. Test setup embedded in preview is live and has callers; no retirement is established by its placement or name |
| Native `runtime`, `files`, `claim`, `capture`, `state`, `sdk`, `control`, `watch` and host `entry/protocol/sdk/browser.mjs` | Bounded private file/NDJSON transport, process groups, ownership, cleanup and host SDK calls | Retain. Unix process groups are explicitly not arbitrary descendant containment; preserve that limit rather than claiming isolation from a package move |
| `packages/values/semantics/src/**`, bindings Rust entrypoints and package-local Cargo workspace | Exact arithmetic, temporal/civil operations, representation, bounded input/plan/validation transport and thin wasm-bindgen ABI | Retain all current native leaves and Cargo identities. Compiler's direct `values-semantics` path dependency remains outside the Values workspace |
| `packages/values/scripts/{emit-semantics-inputs,build-semantics,stage-semantics}.mjs`, `bindings/generated/**`, native conformance examples/tests/data | Owner-derived facts, native build outputs, committed asset inventory and controlled staging | Retain producer/data ownership. Normal JS build checks four declared generated outputs before staging; it does not compile Rust or activate WASM implicitly |
| `editors/vscode/**`, `tools/can_parser.py`, `tools/README.md`, remaining tools and native notices/locks | Editor host/client/configuration/icons and syntax prototype; language-advice helper; unit-test ban/build/notices | Retain exact leaves. Raster previews/notices/locks are not generated code to delete opportunistically. Python remains a documented active syntax tool, not an alternate semantic authority |

## Workflow traces and failure boundaries

1. **Compile and check.** `cli.rs::run_compile` freezes operand/saved roots, calls the owning analyzer, prepares Given and Then joins, emits diagnostics before any artifact on analysis/join failure, calls `codegen::emit` with the same SourceDb/catalog, then attaches and stages saved modules only after both joins. `analysis/mod.rs` fixes parse/resolve/types/effects/examples order; `check.rs` owns diagnostic dedup/sort/completeness. `SourceDb` and catalogue owners are not interchangeable content hashes.
2. **Prepared source authority.** `FreshSourceContext::prepare_inner` validates the original cohort, checks original source again, lowers a fresh original IR, records diagnostics and physical trees, and compares actual owners/callees. `PreparedSendGuards` seals the entire actual execution closure. `when_at_source` is part of IR semantic comparison; JS emission refuses source evaluation without the original retained staged-rule census. These are source facts. State still independently owns actual Work admission, live policy, source DATA grants, mutation/finalization and replay. The completed overdue migration is a precedent for preserving phase differences, not permission to rewrite every named profile mechanically.
3. **LSP and editor.** `lsp/transport.rs` bounds headers and body, tolerates split reads and equal duplicate Content-Length, refuses malformed/conflicting/over-budget frames, and makes no resynchronization promise. Server source/version snapshots govern publish/currentness and full-text sync. `RealAnalysis` consumes the shared compiler/IDE model; the editor custom client owns subprocess/framing/request/disposal and maps the current document, not a second semantic checker. Existing tests mix real server processes and stub analysis; assertions about one do not prove the other or a packaged editor install.
4. **Generation custody.** CLI saved-unit validators walk the complete local module closure once, normalize relative paths, refuse escapes/missing UTF-8 targets, bare/Node/file imports, nonliteral edges and CommonJS, and sort consumed files into the fingerprint. A file move must preserve that confinement and all error locations. The handwritten scanner is an established finite admission profile; this audit has not established a parser bug or authority to replace it with unrestricted JavaScript acceptance.
5. **Development lifecycle.** Native `Owner::start`/`Loop` own claim, current generation and serialized state transitions. `CheckWorker::perform` captures inventory, binds a current ticket, asks owner about safe serving reuse, invokes compiler, and reports facts. Preview admission checks exact compiler bytes and selected callable profile before allocation, then derives binding configuration and preflights the fixed host. Private SDK file references check path ownership, no aliases, mode, bounded size and before/after byte identity. Cleanup and lost runtime facts retain ownership and block a fresh allocation until reconciled; fixed Node calls do not gain publish authority.
6. **Native exact Values.** Compiler Cargo directly consumes `values-semantics`; the JS package independently exposes opt-in backend bootstrap. Thin Rust WASM entrypoints delegate to the versioned exact/validation transport. Native input arenas/budgets and ordered violation construction remain separate from host-record/projection and Intl admission. Committed generated WASM and glue are checked/staged by build scripts; their file digests establish those bytes, not all upstream source parity or every host's ICU/timezone data identity.

## Findings and constrained decisions

### LANG-GRAMMAR — source qualifier absent from the exact grammar

**Classification:** current source-contract/documentation defect, not a demonstrated runtime failure. `DESIGN.md:710`, parser.rs around 6031 and current overdue source use `when_at=source`/`current`. `GRAMMAR.md:112` and production at 396 still define `send ordinary values [when=ordinary] as NAME` with no phase slot. `tools/can_parser.py:1105–1110` also stops the `when` expression only at `as`; the editor grammar has no `when_at` entry. Consequently the advertised exact grammar is stale, and prototype/editor phase behavior cannot be assumed equivalent. No parser/prototype/editor test was run by this audit.

**Correction:** one language-owner packet updates the EBNF/slot prose, adds the literal phase position to the active Python prototype if its advertised grammar is kept, and checks TextMate keyword/expression boundaries. Keep the default/current live semantics and explicit source phase; reject missing `when`, dynamic/quoted/unknown phases. Root owns the canonical finding queue; this record owns the language portion. Independent platform challenger confirmed the actual grammar gap and active prototype caller. No new runtime phase or further source changes are selected.

### LANG-OWNERS — command and proof responsibilities share very large files

**Classification:** architectural debt, not a correctness finding from line counts. CLI combines command parsing, compile joins, renderer subprocesses, saved generation publication/validation and local JS closure custody. `scenario_decisions.rs` combines one private source-context constructor/semantic join with optional nongrant observation serialization. Owner workers are mixed with serialized session authority. Selected splits above name complete cohesive duties while retaining one defining authority. Broad `types`/IR/emitter/disclosure/receipt splits remain gated on full internal caller/callee maps; no mechanical rewrite of those modules is included merely because they exceed the threshold.

### LANG-CURRENCY — compiler still carries an admitted-code mirror

**Classification:** consolidation opportunity; no mismatching currency set demonstrated. `types.rs::KNOWN_CURRENCIES` manually mirrors the 165-code 2026-09-17 owner pin, while `values_semantics::currency_facts::currency_table_scale` already consumes generated owner-derived facts. Reusing that native membership lookup could remove a future divergence source. Preserve the compiler's excluded-N.A. versus unknown diagnostic wording and physical spans; a silent replacement changing errors is not a mechanical move. This is a separate small C/V packet after runtime Values owner confirms the owner-generated exclusion/error contract; it does not block the selected splits.

## Language and package fit

| Duty | Technical recommendation | Strongest actual alternative and tradeoff | Controlling policy and limits |
| --- | --- | --- | --- |
| Shared compiler, LSP and CLI | Retain one Rust crate/binary, private semantic/proof modules | TypeScript could reuse host catalog/JS ecosystem directly and reduce cross-language schema mirrors; it would require recreating CLI/LSP/source-owner identity, exact lowering/error ordering and installed native distribution. No evidence makes that port cheaper than removing the actual duplicate facts | No user restricted alternative set. Current supported toolchains, not a universal claim Rust is best |
| Native dev owner plus Node SDK bridge | Retain Rust serialized session/claim/process lifetime and fixed Node host | A Node-only owner could remove the bridge protocol and use SDK/watch/browser libraries directly, but must transfer the existing native claim, cancellation, private file and process-group lifecycle. Rust-only SDK replacement would recreate established host libraries | Preserve present installed can/can-dev and protocol v1. No topology or measured performance benefit established for a port |
| Editor client | Retain current TS client for this plan; keep standard-client migration as an unselected alternative | A maintained LSP client could remove handwritten framing/lifecycle code, but changes dependency/package/activation behavior and requires real edit/currentness/disposal/install equivalence | Zero-dependency/empty-typeRoots is an existing manifest/source constraint, not a newly ratified user language policy or proof against all alternatives |
| Native Values and opt-in WASM | Retain pure exact Rust core and thin bindings, with TS runtime/Intl boundaries intact | TS-only removes WASM asset/ABI/build maintenance but duplicates exact compiler-side semantics or abandons a shared native owner; moving every host validation into Rust would invent unsupported Intl/authority parity | Only explicitly supported domains are ported. Generated asset integrity and conformance vectors do not establish all-host semantic equivalence |
| Python syntax tool | Retain until active documented callers migrate with syntax-only/location equivalence | Rust-only syntax checking eliminates drift but full semantic checking is not an equivalent syntax-only command. A deliberately retired prototype needs README/tool/caller cutover, not deletion by grep count | Current README/tools usage is real; no prototype retirement selected |

No new language, package, daemon, sidecar or service is selected. `.can` remains the product language and owning business model, not an OS-specific source-folder label.

## Tasks, writer ownership and dependencies

These are planning packets, not implementation authorization or dispatched work. L01/L02/L03/L04/L05 each have one completion lead even when their callers span another packet.

| Packet | Slices and literal writer set | M/C/V work and dependency | Completion and remaining gate |
| --- | --- | --- | --- |
| LANG-01 phase grammar alignment | L01/L03; `docs/specification/GRAMMAR.md`, `tools/can_parser.py`, `editors/vscode/syntaxes/can.tmLanguage.json`, existing owning syntax/highlighting fixtures only | C: synchronize the explicit phase grammar with current parser/DESIGN; V: actual malformed/default/source/current acceptance, physical locations and editor expression-boundary behavior | Ready source contract; no other tree extraction prerequisite. Do not turn prototype syntax into semantic authority |
| LANG-02 CLI command ownership | L03; `compiler/src/cli.rs`, new `cli/{args,compile,reference,generation,entry}.rs` | M: move complete selectors above with one shared reader/locator definition; V: actual CLI error/format/stdout/default/native/catalog/saved-generation import-closure and lease/accept/reset cases | Requires full shared-helper caller list at cutover. Public `canlang_compiler::cli` API, `can` bin and completion scripts unchanged |
| LANG-03 source correspondence owner | L02; `compiler/src/codegen/{scenario_decisions,source_context,source_correspondence,mod}.rs` and actual private-import consumers | M: split immutable context/comparison from observation transport without cloned state; V: original/mutated source, IR trigger/mode/arguments/callee/schema tests and real native State integration | Extraction may proceed independently of LANG-02; sole module-root writer coordinates imports. Do not count a passing optional observer serializer as execution authority |
| LANG-04 development worker ownership | L04; `dev-server/src/owner.rs`, `owner/{check_worker,service_worker}.rs`, `lib.rs` only if required | M: move full worker structs/impls preserving owner events/tickets/resources; V: actual stale-result/cleanup-retry/foreground-owned versus attached behavior plus installed dev-server startup | No new process/API; Rust module visibility and installed host selectors must close. Uninspected browser-test branches remain a separate evidence limit |
| LANG-05 currency owner reuse | L01/L05; `compiler/src/analysis/types.rs`, native owner helper or generated facts only if required; existing literal/value fixtures | C: eliminate admitted-code mirror with identical error class/message/span and exclusion behavior; V: pinned owner-table differential and literal diagnostics | Gated on runtime/native Values agreement on excluded-code diagnostics; no performance claim or new table selected |
| LANG-06 retained language/native source review | L01–L05; retained current leaves not moved above, mapped by shared inventory; no production writer assigned by audit | V/planning: complete remaining checker/emitter/disclosure/receipt/test-branch review before new correctness/retirement/port conclusions. Preserve independent example expectations, generated native data and notices | A substantive-review gate, not an instruction to refactor every retained file or rerun all suites |

The coordinator owns compiler `codegen/mod.rs`, Cargo/package/lock changes, installed selectors and any shared fixture handoff. CLI and native-owner original files have exclusive writers. Review/analysis may be parallel, but no two lanes split different hunks of the same original owner. Existing Rust integration tests under `compiler/tests`/native semantics tests and allowed TS integration files remain their actual subjects; no unit tests are introduced. Future verification broadens from affected source/IR/protocol cases, through real import/build/install selectors, to installed editor/dev/runtime workflows only when authorized.

## REPO-UNIT-SCOPE — native development crate is outside the enforced Rust scan

Root owns canonical finding `REPO-UNIT-SCOPE`. Fresh source inspection confirms 114 `#[test]` lines and 25 `#[cfg(test)]` lines across 25 files under `dev-server/src`; `owner.rs:2775` begins one such module. That module mixes direct private-helper assertions (`check_preview_reason`, `rank_lookup`, `valid_projection`, `source_result`) with a more integrated worker/current-capture/thread/event test. The other modules include process, file, gateway, watcher and UI scenarios as well as direct helper assertions. These are existing source facts, not a claim about their introduction date or current execution results.

The controlling root AGENTS bans Rust `#[test]` and `#[cfg(test)]` under crate source regardless of whether an individual body exercises several collaborators. `scripts/check-no-unit-tests.sh` checks the TypeScript allowlist only. The shared `tools/unitban/build_impl.rs` scans the manifest directory of the **including** Rust crate. Compiler and Values native/binding crates include it in their build scripts; `dev-server` has no `build.rs`, no manifest build-script override and no corresponding source-level enforcement. Therefore passing root TS gates or a compiler build does not establish compliance of the dev-server crate. The statement that all Rust crates enforce the ban currently exceeds that actual coverage.

**Planned correction ROOT-POLICY / language portion LANG-07:** inspect each of the 114 existing test bodies by subject and preserve required lifecycle, stale-result, private-file, process-group cleanup, HTTP gateway, cancellation and failure behavior through real public owner/control/process integration seams. Existing `dev-server/tests/gateway.rs` exercises actual sockets/HTTP; `tests/state.rs` calls SessionState directly and its location alone does not certify that every test is a meaningful integration. Do not merely rename or relocate private-helper assertions to `tests/` and call them integration tests. Do not discard useful behavior or infer mass deletion authorization from this audit. Only after the legitimate behavior cases and fixture ownership are reconciled should a new `dev-server/build.rs` include the existing shared compile-time scanner (from `../tools/unitban/build_impl.rs`) and invoke it. Root owns any shared script/scan-root change. Public test fixtures must not expose production authority or create a second owner state machine to make a test compile.

Exact proposed additions for that gated correction are `dev-server/build.rs` and `dev-server/tests/session_lifecycle.rs`; the latter is for actual owner/control/worker lifecycle scenarios, not a destination for every current unit helper. Existing `dev-server/tests/gateway.rs`, `dev-server/tests/state.rs`, all 25 affected source modules and shared test-support/readiness APIs require one coordinated writer/fixture handoff. Individual helper-only assertions can be retired only against their established contract and retained meaningful workflow coverage. This is a correctness/policy packet distinct from mechanical LANG-04 worker extraction; it blocks any claim of complete no-unit-test enforcement, not unrelated planning. No test, scanner or build was executed here.

## Exact disjoint LANG-02 selectors

Selectors below are pinned to the recorded source. Each entry moves a complete top-level declaration (and the complete impl where shown); no declaration is selected by two targets. All remaining top-level declarations, imports/module shell and shared public facade stay in `compiler/src/cli.rs`. Line ranges are navigation aids; the enumerated names define ownership. Shared helpers are imported from their one defining target, never copied.

### `compiler/src/cli/args.rs`: current lines 550–833

```text
struct ParsedArgs
fn parse_simple_flag
fn parse_root_settings_flag
fn parse_path_valued_flag
fn parse_valued_flag
fn check_flag_scope
fn check_docs_flag_scope
fn parse_args
fn parse_format
```

### `compiler/src/cli/compile.rs`: current lines 937–1776

```text
fn read_source_file
fn read_source_text
fn add_source
fn run_check_like
fn run_compile
fn frozen_source_db
fn compile_saved_roots
struct GivenJoin
fn prepare_saved_given
fn join_saved_given
fn given_saved_unit
fn attach_saved_given
fn attach_saved_then
```

### `compiler/src/cli/reference.rs`: current lines 1777–2115

```text
fn run_policy
fn run_docs
fn run_docs_with_platform
fn docs_out_refusal
fn render_via_platform
fn read_renderer_pipe
fn stderr_tail
```

### `compiler/src/cli/entry.rs`: current lines 2169–2253

```text
fn run_source_entry
```

### `compiler/src/cli/entry.rs`: current lines 2741–2821

```text
fn run_thin_entry
fn run_dev_entry
```

### `compiler/src/cli/generation.rs`: current lines 2822–7788

```text
fn run_gen
fn run_gen_request
fn run_gen_platform
fn gen_envelope_result
fn echo_header
fn dispatch_gen_operation
fn run_gen_not_implemented
fn generation_source_path
fn generation_source_file
fn read_gen_source
fn load_gen_saved
fn run_gen_bind
struct GenStatusReport
struct GenScopeData
fn collect_gen_scope_data
fn report_retained_group
fn collect_gen_status
fn gen_issue_json
fn run_gen_status
fn run_gen_status_json
fn tool_message
fn status_next_actions
fn run_gen_doctor
fn run_gen_inspect
struct InspectedUnit
impl InspectedUnit
fn contract_json
fn category_for_kind
fn inspect_recipe
struct BindScope
fn bind_acquire_scope
fn bind_read_target
struct BindPrepared
fn bind_prepare_request
fn bind_adopt_legacy
fn bind_apply_request
fn bind_check_slot
fn bind_scope_evidence
fn bind_check_bindings
fn collect_publish_replacements
fn bind_publish
fn run_gen_bind_json
fn admit_execution_settings
fn admit_readable_files
fn admit_saved_unit
fn run_gen_generate
fn run_gen_refine
fn run_gen_retry
fn admit_validate
fn run_gen_validate
struct ValidationFailure
impl ValidationFailure
fn validation_failure_envelope
fn validation_check
fn intake_issue_next
fn diagnostic_summary
fn diagnostic_in_span
fn runtime_targets_for
fn validate_saved_unit
fn modified_since_generation
const DECLARATION_FILE
struct SavedDeclarationFile
fn read_saved_declaration
fn require_group_text
fn check_validation_source
fn check_one_given_unit
fn validate_keyword_unit
fn validate_trait_unit
fn reject_unexpected_declaration
fn validate_style_unit
fn validate_view_unit
struct JsImportEdge
struct JsModuleScan
fn blank_js_range
fn blank_js_line_comment
fn blank_js_block_comment
fn blank_js_string
fn blank_js_template
fn blank_js_trivia
fn is_js_ident_start
fn is_js_ident_part
fn read_js_ident
fn skip_js_ws
fn skip_js_trivia_original
fn js_keyword_at
fn read_js_specifier
struct JsScanState
impl JsScanState
fn find_from_specifier
fn scan_js_module
fn is_unit_relative_specifier
fn admit_js_imports
fn admit_js_imports_inner
fn normalize_unit_import
fn resolve_saved_js_closure
fn split_saved_path
fn validate_saved_files
struct SavedUnitRecord
fn load_saved_unit_record
fn validate_saved_declaration
fn check_saved_keyword_implementation
fn check_saved_view_implementation
fn check_saved_trait_implementation
fn validate_saved_implementation
fn validate_saved_contributions
fn check_saved_style_assets
fn validate_saved_style
fn validate_one_saved_file
fn admit_adopt
fn admit_accept
fn admit_cancel
fn admit_reset
fn admit_edit_begin
```

`locate_platform_bin` (2116), `checkout_platform` (2147), `find_on_path` (7789), all public dispatch/analysis carriers, help/explain, format/lint and atomic IO helpers remain in the parent facade. Any consumer requiring a moved helper uses the target-owned implementation through the minimum crate-internal visibility; no second ownership is introduced.

## Independent challenge and disposition

`audit_platform` inspected the present native preparation/Node host/CLI joins and challenged four consequential choices: the existing editor package constraint must not be relabeled user policy; Node-only dev could remove IPC but would move actual claim/generation authority; proof extraction must preserve immutable borrowing/private caches/one constructor; and CLI splits must not duplicate saved-binding/default binary locators. Those objections are accepted and reflected in the allocations. Required installed joins include `scripts/verify-installed-startup.mjs`, `scripts/verify-installed-dev-server.mjs`, `scripts/verify-installed-lsp.mjs` and compiler completion scripts. Platform also independently confirmed the grammar gap and that an active documented Python consumer prevents evidence-free retirement.

As challenger of runtime allocation, this reviewer required all capture/owner/Work/query-budget maps to retain one State authority, while pure plan/ordering/CRUD projection could move. Runtime narrowed its proposal accordingly: no sessionstate extraction or new capability DTO, pure helpers moved rather than cloned, and old app profiles migrated only with original phase/permission/failure conservation. That is a source-level ownership challenge, not execution of runtime tests.

The later root/platform source challenge confirmed REPO-UNIT-SCOPE and its enforcement-only coverage limit; the gated LANG-07 correction is recorded above. No unresolved owner decision blocks LANG-01–04's specified planning. LANG-05 has a named equivalence gate. Remaining checker/emitter/browser/fixture branches are explicitly not promoted to complete substantive review or installed qualification. Read-only source/catalog inspection and the independent challenge are the only new evidence performed here.
