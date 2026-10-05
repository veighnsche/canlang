# Living ideal file tree for Canlang

This is a researched, deferred organization plan. Maintaining it does **not** authorize implementing it. No refactor, manifest or runtime-configuration change, commit, merge, push, automation, hook or CI addition belongs to this documentation task. Proposed filenames, APIs, exports and final file sizes remain **unverified until implementation**. Current sizes are observations, not targets or splitting limits.

## Checkpoints and review scope

| Record | Value |
| --- | --- |
| Exact checkout | `/Users/vince/Projects/canlang`; remote `git@github.com:veighnsche/canlang.git` |
| Reviewed branch | Started on `muse/closeout/runtime-b1`; other sessions switched the shared checkout through `muse/closeout/b1-followups` to `muse/closeout/lane6-e2e` |
| Initial full-review starting baseline; keep permanently | `e93adebb3397ef2545efee82006d8227bc361518` — 1,881 tracked paths |
| Latest reconciled committed source | `8249342707d3280e88e39e8c911b7e457828f31f` — 1,897 tracked paths, including one gitlink |
| Maintenance date | 2026-10-05, Europe/Brussels |
| Review scope | Full tracked parent repository, hidden tracked files, nested evidence/snapshots, implementations, tests, fixtures, assets, build/install/release wiring, reachable Git history, and the pinned draft submodule's 148 tracked files |
| Draft authority and pinned source | Independent `canlang-drafts` repository at `2d673127e03e8b8bc369a7a34858165c034df131`; parent tracks `draft` as mode `160000` |
| Remote verification during review | Read-only `git ls-remote` first matched feature `9919514` and main `e93adeb`; later main advanced to `e8d6283` (squash #122). No fetch, branch switch, pull or merge was performed by this task. |

The review began with unrelated compiler/platform/runtime edits and untracked files. Another session committed them as `9919514` during the audit. The 20-file delta (16 additions and four modifications) was reconciled: B1 workflow, compiler JS/tests, runtime evidence, platform loader/context/invocation/stdlib/assembly and tests, and testkit loader/tests. Later committed deltas are recorded separately below; a committed checkpoint does not claim to include future or uncommitted changes. The initial baseline remains fixed even as the latest checkpoint advances.

The inventory includes tracked generated evidence and published assets; these are not ignored build products. It excludes ignored `node_modules`, Rust `target`, package `dist`/coverage, editor `out`, packaged `.vsix`, Wrangler/Miniflare stores, browser reports/caches, Python bytecode, `.DS_Store`, Git internals and private inputs. No directory-wide disk scan turns those into source. The submodule is listed separately so its files are not mistaken for parent-owned paths.

Read scope means every tracked text file was read or structurally decoded, including large JSON arrays and nested case/snapshot contents; live implementations were reviewed for responsibility, imports, state and test seams. PNGs were visually inspected. Historical programs and generated token dumps were examined as evidence, without executing them or claiming their behavior is verified. Dependencies, private editor settings and historical external environments were not audited.

### Incremental reconciliation during the initial audit

The complete inventory and size ledger use committed source through `8249342707d3280e88e39e8c911b7e457828f31f`, whose source tree is identical to reviewed `b52ad877214b9f7d2ad678bb62d2709260bdaa4d`. `3f3b8df` fixed loader IDs/module cross-references, real HandlerContext typing, invocation argument arrays and caller/membership mapping; source and changed tests were read together. `e8d6283786940580a73a3bf8a14ffd77d6741b97` is the external squash merge of that runtime work (#122); its source tree was compared with the reviewed feature commits. The shared checkout then moved externally to the follow-up branch.

`473f959` adds required `ArtifactCallable.member: string[]` in contracts: explicit nonempty path segments into `canApp()` distinguish exported identity constants from implementations. At that intermediate checkpoint, compiler/emitter, loader, invoker and typed fixtures had not joined this field; `b52ad877` completed the source linkage described next. The desired tree preserves the existing artifact contract/registry ownership; do not infer handler paths from IDs or turn identity exports into callable functions. All affected consumer locations were traced.

That follow-up work subsequently landed externally as `b52ad877214b9f7d2ad678bb62d2709260bdaa4d`: twelve modified paths, no additions/removals/renames. The compiler artifact/IR/JS, b1_join/codegen tests, platform artifact/invoke/assembly and tests, and runtime evidence were reviewed with affected consumers. It propagates member arrays into artifact JSON, validates them, invokes `canApp()` registry members with no direct-export fallback, awaits all record queries and supplies omitted CRUD/scenario form field selectors while preserving explicit fields. Old version-1 artifacts lacking member paths now require recompilation. Page descriptors remain direct module exports; callable linkage does not change their lookup.

The prior linkage/query-await/omitted-selector proposals are implemented in source and removed from unresolved blockers. Preserve the new registry helper in the selected JS registry module, query async traversal/rendering in IR/JS expression modules, and resolved operation/default-selector work in IR UI decoding. Producer evidence reports narrow runtime/emission probes; this documentation task did not rerun them. **The complete form producer join is still open:** emitted `fields:["title","content"]` goes directly to `ui.form`, but contracts require `FormFieldDef[]` and UI reads `field.path`, `type`, `required` and `label`. No selector-to-descriptor resolution is present. Required action/operation/mode/time-zone/submit/id-prefix metadata also needs its owning producer/dispatcher join; emission-string assertions do not prove rendered forms. The evidence document's “form fields — DONE” therefore means default selection only. Model stored fields are not automatically writable checked operation inputs; allowed fields, server-owned/defaulted fields and bound arguments remain unverified. PresentationContext construction/pre-session CSRF and canonical invocation/stdlib ownership remain integration questions. The temporary untracked probe disappeared in the other session; this task neither inventoried it as source nor modified it. The other session then squash-merged that follow-up as `8249342707d3280e88e39e8c911b7e457828f31f` (#123). Both commits have tree `06ad65c3931906fb8bd35608380f478ccbad87c8`: reviewed; no structural changes. The checkpoint advances to that merge result. Separate working edits to `implementation/status/lane-01.md` and `tests/e2e/fixtures/artifact-loader.ts` were preserved and distinguished from the committed checkpoint. The status edit routes remaining work; the loader edit adds member-shape checks and accepts producer min_version 0. Its handbuilt/compiled branch and caller paths were rechecked; it remains uncommitted and the compiled path remains unsupported. This task owns only the new plan and four guidance/index edits.

### Concurrent uncommitted overlay; checkpoint unchanged

A separate session is continuing source work after merge `8249342`. The latest tracked-path inventory still contains 1,897 paths. Its working edits to compiler JS/codegen tests, cloudflare invocation/assembly, interfaces pages, e2e artifact validation and lane status were read separately from committed source. New `packages/interfaces/src/http/presentation.ts` factors the full/partial page context constructor; `packages/interfaces/test/http-presentation.test.ts` is its owning test. These useful internal leaves are selected below but marked future relative to the checkpoint. They are not yet a verified public API or a completed Cloudflare page join: assembly still mirrors context construction. The dirty JS page preamble now reads preferences from admitted `bindings.preferences` rather than HandlerContext, with an emission-string test; generated admission still returns an empty bindings object, so the actual preference producer join remains open. Dirty JS/codegen-test sizes are 3,143/3,031 lines versus committed 3,142/2,970; the ledger deliberately records committed sizes.

New `packages/cloudflare/src/runtime/executors.ts` and `packages/cloudflare/test/runtime-executors.test.ts` are uncommitted interim B2 witnesses. The store decorator appends work dispatch rows to the same fenced commit as an outbox write; its entry is not wired through assembly/CLI/work runner, and local-literal tests do not prove parity with the canonical work row builder. Retire the interim decorator/row builder when the compiler and state/work owners supply the final dispatch path; do not add a permanent executor package/service to this tree. The selected state invocation/builtins and work table owners remain responsible for final semantics. `packages/testkit/src/fixtures/b2-delivery.ts` appeared later as untracked ongoing work. Its eleven playback mail rows, send/retry/reconcile expectations, completion/redaction guards and structural type mirrors were read; no consuming integration test was present at inspection. It remains outside the completed committed-source reconciliation. Review the eventual test caller/build exports and consolidate equivalent completion/schema checks with their existing owners when that work lands. Other continuing overlay changes also require their merge handler's incremental review. The previous checkpoint is retained for this incomplete, moving overlay. No external working file was edited by this task.

## What the source establishes

Canlang has one Rust crate, twelve TypeScript runtime/tool workspaces, a separately packaged VS Code extension, Python syntax/research tools, authored `.can` examples and an independently owned drafts submodule. Historical adoption experiments additionally contain Python/Django, HTML/CSS and JavaScript witnesses. Those experiments and snapshots are fixtures/evidence, not production packages or deployment recommendations.

The language/application identity remains in `.can`: owning declarations determine dependencies and interfaces, small apps retain their implicit package and larger products compose existing owners. File placement must not rename Can packages, model identities, operation IDs, migration owners or capability authorities. [DESIGN](../DESIGN.md), [GRAMMAR](../GRAMMAR.md), [REQUIREMENTS](../REQUIREMENTS.md), [DECISIONS](../DECISIONS.md) and [implementation contracts](../implementation/CONTRACTS.md) remain their established authorities. This plan does not adopt unimplemented draft APIs or AI/service proposals.

The [layout experiment](../design/evaluation/evidence/adoption/experiments/layout-assessment.md) compared one 215-line file with three files totaling 213 lines. Both localized changes, and differences in semantics/actor coverage prevent a token/time winner. Use demonstrated ownership and change seams; size triggers inspection, never a mandatory number of files.

### Language ports and their actual consumers

| Implementation | Verified history and wiring | Recommendation and limits |
| --- | --- | --- |
| Rust compiler | Grew from the `4df5eea` scaffold; syntax foundation `bc008f7`, analysis `9d5933d`/`cd2fe87`, IR/JS emission `10a1a0e`, authoring backend `08abe86`, page artifacts `52ed896`, runtime join `9919514`. CLI, LSP, editor, generated artifact contracts, values catalog and Rust tests consume it. | Keep one crate and one compiler ownership chain. Split private pass responsibilities, not crates. Rust's maintenance/parity cost is observable; speed or safety improvement over a full previous compiler was not measured. |
| Python syntax prototype | `tools/can_parser.py` and its tests entered in `4df5eea`. It has its own lexer/layout/expression/declaration parser. Current integration CI runs boundary tests, excluding stale corpus tests, and parses the corpus informationally. Tool README and root README still invoke it. | Retain in the chosen tree until syntax-only acceptance/location parity and callers are migrated. Proposed retirement gate below; do not keep evolving two normative parsers indefinitely. Rust semantic rejection is not equivalent to Python syntax rejection. |
| Claimed old TypeScript compiler | No compiler `.ts`/`.js` implementation or deletion was found in reachable history. `/Users/vince/Projects/can-lang` is absent. | Do not invent an unused mirror or evidence from another checkout. This audit cannot assess unavailable old-project source. |
| TypeScript runtime | Real library behavior, provider bindings and workerd-hosted JS consumers; it is not a port of compiler parsing. Rust produces existing catalog/artifact/JS contracts. | Keep JS runtime and Rust compiler responsibilities. No language-driven sidecar, service, IPC mechanism or adapter layer is proposed. Existing CLI/LSP contracts remain. |
| Handwritten draft `.mjs` | Draft README, DESIGN §13 and file headers label these desired output. They contain app descriptors, functions/handlers, pages and deferred fixture/example recipes; proposed imports are not proof of working APIs. | Retain as proposed output witnesses under independent draft ownership. They did not replace runtime libraries and are not compiled artifacts. Keep test recipes distinct from desired production output. |
| Historical experiment ports | Frozen adoption comparisons preserve separate Can/JS and Python/Django attempts plus checked fixture/configuration witnesses. | Retain exact bytes and original conclusions; no production package consolidation is inferred from experimental language choices. |

### Package ownership and install/build graph

The desired tree keeps the twelve semantic workspace owners. This is a recommendation, not proof that twelve separately published packages are optimal. Root Bun already provides a single install (`packages/*`); differing producer builds/exports are integration debt, not a reason to introduce a deployment boundary. Keep a useful public standard-library facade; a values-only facade today is narrower than its documented eventual role.

| Package | Owning responsibility, consumers and selected decision |
| --- | --- |
| `contracts` | Shared producer protocols consumed by compiler artifacts and all JS domains; includes runtime constants despite its type-only description. Keep neutral ownership; presentation/state families split behind existing barrels. Resolve branded state versus wire OperationId and duplicated DeliveryStatus deliberately. |
| `values` | Exact values/schema/wire/pure operations; stdlib, compiler JSON catalog and conformance join consume it. Keep one implementation/catalog; schema/wire/ICU responsibilities split privately, fixtures remain versioned. |
| `state` | Admission, authorized queries, mutations, owner fences and migration; preserve D1 batch versus DO transaction mechanics. Shared SQL/row planning consolidates; memory storage becomes an explicit testing surface. |
| `work` | Durable events/schedules/delivery observation and state system commands; its state dependency is type-only today. Keep staging/claim/replay/supersession together; split command/table families and move doubles out of production ports. |
| `files` | Upload intent/content/finalize and receiving-owner authority; shares scenario types with services. Keep lifecycle and provider-neutral ports; isolate Node filesystem storage and test doubles. |
| `services` | Frozen request/provider mapping, uncertainty/reconcile/stream/cancel; files/testkit consume scenario data. Keep adapters within this owner, extract provider-neutral completion/error logic from mail, separate Node harnesses from production ports and share Worker-safe scenario validation. |
| `identity` | Accounts, memberships, sessions, team/role facts and credentials; interfaces and real local-worker journeys consume it. Keep one identity authority and explicit testing export. |
| `interfaces` | HTTP/MCP/OAuth/ingress/upload framing, authentication and canonical invocation; consumes contracts/identity/UI. Keep transport semantics and parity tests; no second state engine. Its field projector has no production callers beyond export; consolidate only proved-equivalent logic or retire after consumer audit. |
| `ui` | Server rendering, shared shell, typed forms/components/navigation and presentation i18n; interfaces, generated imports and workerd journeys consume it. Keep one public UI API. Break forms/controls dependency cycle through owning field primitives; localize through values only after profile agreement. |
| `stdlib` | Generated code's public standard API facade, presently values-only. Keep the stable import and thin producer assembly; do not clone producer implementations or leave provisional cloudflare primitives as its permanent data plane. |
| `cloudflare` | Node build/dev/deploy/local engine and Worker binding assembly. Separate Node artifact/module staging into `src/build/`; keep Worker execution export graph explicit. Replace interim state/context/invocation/stdlib mirrors through settled state and interface producers. |
| `testkit` | Compiled example artifacts, fresh row scopes, exact observations, rejection/no-change proof and scenario playback. Keep separate from production runtime; it consumes real producer admission once joined. Unsupported rows never count as passes. |

Verified install/build limits: [root manifest](../package.json) installs all twelve workspaces once, but root build emits only contracts/cloudflare/testkit and the values join. [Root checking](../tsconfig.check.json) excludes a playback suite pending producer strictness; [root Vitest](../vitest.config.ts) does not own every producer suite. Work/files/services use `.ts` source and have no built package exports/build scripts; interfaces has no shipping main/types/exports. Values/state/UI/identity dist trees include widened sibling source roots. Release packs only contracts/cloudflare/testkit/state/values. Normalize that wiring as one later integration change, preserving actual Node test versus Vitest ownership and generated consumers; do not call the present release set a complete install.

The alternatives were assessed against the same workflows: keeping owners minimizes import/public-API churn but retains manifest maintenance; three grouped domains can reduce release wiring but must migrate catalogs, stdlib/UI specifiers, fixture paths and all consumers; one runtime package offers fewer release units but the largest API migration. None automatically removes Node dependencies or preserves authority. No timing, performance or safety benefit was measured. The selected tree preserves owners and fixes duplicated responsibility; revisit grouping only with concrete distribution/consumer evidence.

Concrete boundary debt: [services ports](../packages/services/src/ports.ts) imports `node:http` solely for its mail test harness, yet production provider adapters import this file for defaults. [Scenario validators](../packages/services/src/scenarios.ts) use Node Buffer while testkit has repeated Worker-compatible validation. Separate production ports/defaults, Node test harnesses and a neutral Worker-safe scenario schema; then share actual validation and run the existing catalog-wide differential suite. This is implementation ownership consolidation, not a new adapter layer.

[Cloudflare module staging](../packages/cloudflare/src/runtime/modules.ts) currently substitutes the whole stdlib import with provisional cloudflare primitives. Their per-write commit/empty history/null receipt behavior does not implement canonical state invocation, and owner-query defaults are not a permission policy. The desired tree consolidates them into state plus stdlib after actual handler contracts land. `can-platform run` currently validates/stages modules and prints URLs; it does not start LocalDev or serve an assembled Worker. Testkit's new loader produces unsupported-invoker rows. Preserve these gaps instead of describing scaffolds or spy-store tests as complete B1 proof.

### Decomposition decisions

Every implementation over 500 physical lines or 30 KiB was an inspection trigger. The review also followed smaller connected helpers, imports and state. Large test suites, registry/schema data, TextMate rules, evidence JSON and long-line specifications require different treatment from production algorithms. The complete size/disposition ledger below includes retain decisions. No final size budget is assigned.

- `analysis/mod.rs:107-150`: check_program parses each source, then resolves, checks types, emits deferred unresolved diagnostics, checks effects, checks examples, deduplicates and sorts. This order is semantic. The resolver must run before types; unresolved names must be emitted after unique expected-enum cases have been claimed. CheckedProgram:82-104 is the downstream input, with module/symbol vectors, TypeTable, EffectTables, ExampleTables and catalog version. Source spans and NodeKey identities are canonical; modules and symbols are index-addressed and source-ordered.
- `resolve.rs:487-500`: resolve_program indexes modules/declarations, resolves imports/ownership/declarations, then finishes with cycle checks. Resolver:585-593 owns tables/current_module/pending_parents. ResolveTables:384-415 owns scopes, name/binding/type-reference maps, unresolved names/members, CRUD and containment indexes and fixture edges. `resolve.rs:504-542` consumes the types pass's claimed cases. Separate files must operate on this one context, not rebuild partial tables.
- `types.rs:372-389`: check_types collects read-scenario flags first, performs declared-type phase 1, body phase 2, then cycles, finally exports declaration/result maps. `types.rs:6701-6730` uses a bounded fixed point for forward field-chain annotations and merges/deduplicates each round's diagnostics. Typer:6324-6382 owns declaration/default shape/results; inferred let/for/alias/row/create/call/send/route maps; preferences and recursive type stack; operation/result/hook/read contexts; call edges, queue/schedule keys and actor-default facts. Ctx:6312-6321 carries strict/light positions and narrowing. Preserve these state transitions across files. Do not instantiate separate typers per feature or change strict/light checks as part of moves.
- `effects.rs:794-811`: check_effects walks files, then all calls/descriptions, then finish, then sorts/deduplicates referenced builtins. Cx:814-847 owns source/resolution/type/catalog inputs, output tables, rule ordinal, hook/current scenario, checks_on, recorded declarations, queue/analytics names, transitive model/call graphs and description attribution. finish:891-911 performs app policies/every scopes and attaches deferred descriptions. effects includes model/record/capability/rule schema carriers because codegen consumes them, not merely imperative statements. Keep this full contract and its global ordering.
- `examples.rs:168-202`: Checker owns CST declaration-node references, import aliases, output tables and all inputs. run:219-247 indexes nodes before checking modules, then checks anonymous inline patterns throughout trees. OpCtx:205-216 distinguishes scenario vs CRUD, trusted callers and results. SequenceState:2152 owns per-sequence let bindings/call observations; selector overlap keys/checks:2048-2150 are their own semantic unit. ICU parsing:2761-3075 is self-contained message-profile validation, though its type classifications are derived from ResolvedType. Keep message validation distinct from language-expression parsing.
- `syntax/parser.rs:415-428`: one Parser holds source/line index, diagnostics, lossless Builder and shared expression/suite nesting counters. `attempt:614-635` rolls back both builder cursors and diagnostic count on speculative failure. Builder:177-263 owns byte coverage/comments. Splitting productions must preserve this transaction, comment ordering, shared caps and recovery behavior. Grammar-oriented files can share this context; separate stateful parsers per section would break it.
- `codegen/ir.rs:614-636`: Cx holds the checked program, sources/catalog, reparsed CSTs, symbol/field/module indexes, builtin observations, page names and preferences validators. The source is reparsed solely to decode anchored syntax/literals; semantic choices remain table-owned (module docs:16-32). `build_program:1350-1386` builds modules, rule maps before items (preference validators are read by items), then bound-capability/migration checks, suites and referenced builtins. Maintain index parity between IrProgram item/module vectors and SymbolId/ModuleId (docs:34-36).
- `codegen/js.rs:312-323`: Emitter owns IR, canonical lookup, deterministic stdlib/UI/relative import sets, diagnostics, builtin references, callable/page linkage. One emitter's lower_expr/stmt/guard/schema/message/UI methods are also consumed by bdd.rs:64-148; maintain that reuse. `emit_program:177-230` lowers page bodies, definition and registry before rendering imports; it snapshots entry imports before emitting package modules. BDD has a separate emitter per suite. No production import of test modules (bdd.rs:11-13).
- `codegen/mod.rs:125-191`: emission completeness gates checked IR -> JS -> suite modules -> artifact assembly. E6005/E6006/E6007/E6008 behavior and loud fail-closed placeholders are public behavior, not filetree implementation details. `artifact.rs:120-208` assembles production modules entry-first, callable/page export references, maps, catalog requirements and separate tests. Requirements are computed from observed imports/catalog version. Existing artifact wire contract in packages/contracts/src/artifact.ts remains authoritative across Rust and JS.
- `ide/queries.rs:223-238`: Snapshot currently parses, calls check_program and re-runs resolve_program for editor scope tables. RealAnalysis:232-454 builds a fresh snapshot for each request; it is not an incremental cache. `lsp/server.rs:536-545` alone owns SourceDb, open-document versions, pending version queue, lifecycle and exit state; `pump:602-613` rejects stale/closed versions. Never move this session state into stateless IDE queries. Potential redundant parsing can be investigated later; a tree reorganization does not itself solve it.
- `format.rs:98-130`: formatter validates through parser then lexes and emits by physical line. Emitter:274-285 owns delimiter/context stack and parent indent; gap:478-701 is one intertwined spacing policy. Retain this 714-line coherent file rather than mechanically splitting by size. Formatting preserves tokens/source order/comments and has no checked-program dependency.
- `lint/driver.rs:184-235,353-390`: lint runs over CheckedProgram plus reparsed sources, configured rules and a catalog deprecation snapshot; warnings never block. rules.rs has conservative read/shadow attribution and intentionally differs from analysis. `lint/driver.rs:288-334` accepts a caller-supplied hash and single/multiple edits; `ide/fixes.rs:139-165` computes actual text hash and validates generalized edits. Similar mechanics but different trust/API assumptions: do not blindly combine these surfaces.

The following selected child files appear explicitly in the tree. Compiler ranges cite the `9919514` inspection snapshot; later linkage/default-field deltas are reconciled below and can shift line numbers. They are not promises of final sizes or public interfaces. Other arrangements mentioned in seam notes are unselected alternatives, not additional desired leaves.

- `compiler/src/syntax/parser.rs` -> `syntax/parser/mod.rs`, `cursor.rs`, `builder.rs`, `recovery.rs`, `modules.rs`, `expressions.rs`, `types.rs`, `attributes.rs`, `given.rs`, `when.rs`, `examples.rs`, `ui.rs`, `migrations.rs`.
   - cursor/Fail/token split:26-176 and264-414; lossless builder:177-263; context/recovery/entry:415-734; module/import/context productions:735-1284; expression/path/label parsing:1285-2186; type/schema/param parsing:2187-2565; header/attribute/route grammar:2566-3148; Given:3149-4071; When/do/control flow:4072-4985; example forms:4986-5419; UI:5420-5939; migrations:5940-6136. Keep helper placement with actual consumers and caps on the one Parser. Long expression/given units can be refined into `labels.rs`/`schema.rs` only if reviewing concrete local callers shows an advantage.

- `analysis/resolve.rs` -> `analysis/resolve/mod.rs`, `tables.rs`, `modules.rs`, `declarations.rs`, `imports.rs`, `scopes.rs`, `types.rs`, `bodies.rs`, `expressions.rs`, `cycles.rs`.
   - tables/IDs/lookup:37-485; driver/deferred diagnostics/Resolver in mod; module indexing623-792; declaration indexing840-1789; imports/composition/ownership1790-2148; lexical scopes/descriptions/context2150-2633; declaration body/default/fixture/rule resolution2634-3286 and When/CRUD statements3602-4133; type paths3328-3601; UI/route/result scopes and expressions4134-4824; fixture/derive cycles4825-4986. Keep declaration indexing one pass, types and expression binding distinct. `modules.rs` may include imports if the resulting indexing/import unit is easier to navigate; either arrangement preserves the same outcomes.

- `analysis/types.rs` -> `analysis/types/mod.rs`, `model.rs`, `declarations.rs`, `expressions.rs`, `members.rs`, `operators.rs`, `narrowing.rs`, `constructs.rs`, `queries.rs`, `calls.rs`, `overloads.rs`, `statements.rs`, `mutations.rs`, `effect_calls.rs`, `scenarios.rs`, `schemas.rs`, `rules.rs`, `context.rs`, `ui.rs`, `fixtures.rs`, `literals.rs`.
   - model Scalar/ResolvedType/TypeTable:60-370; driver/context/Typer constructor in mod:372-390 and6303-6457; phase-1/fixed-point declared types6694-7746; expression entry/literal/name/binding/context types7754-8324; members8325-8888; operators8922-9741; narrowing9742-10056; constructs10057-10525; queries10526-10700; call dispatch/argument binding10701-11436; catalog overload matching11437-12329 plus Trial/SigVar12330-12506; statement control dispatch/let/return/if/for735-869,2256-2417; create/set/delete+CRUD inputs870-1261,1722-1938; effect call/action/invocation and emit/send/schedule/cancel1262-1721,1939-2255; scenario/default/source checks2475-3077 plus read/call graph3706-3802; schema/field/label/message/default/modifier checks531-734,3078-3705 and FieldParts6601-6693; rules3803-4139; deployment/role/derive/capability/CRUD context4140-4785; pages/UI4786-5305; fixture validation5306-6120; literal validation and scalar/domain helpers6121-6302,6458-6600,12507-12698,12728-13167. Member/schema helpers2418-2474 should follow their consumers. crud_op_enabled12699-12727 belongs in shared Typer method helpers, not literals. These ranges describe concrete seams; helpers may be moved adjacent to users without changing a signature. `statements.rs` remains traversal/control and `effect_calls.rs` checks statement-level effects; `calls.rs` checks expression calls. Keeping these separate avoids mixing strict/light behavior.

- `analysis/effects.rs` -> `analysis/effects/mod.rs`, `tables.rs`, `declarations.rs`, `rules.rs`, `handlers.rs`, `statements.rs`, `descriptions.rs`, `migrations.rs`.
   - output carriers81-793 -> tables; Cx/driver/walk orchestration794-1095 -> mod; schema declarations1096-1494 -> declarations; rules1495-1815 plus app-policy/every-scope finish3083-3194 -> rules; CRUD/scenario/on sources1816-2214 -> handlers; statement/effect targets2215-2783 plus call/redundant actor validation2987-3082 -> statements; page record2784-2801 remains small traversal; migrations2802-2918 plus3796-3821 -> migrations; description/call collection2919-2986 and3571-3795 -> descriptions. Pure helpers3195-3570,3822-4084 follow actual consumers or syntax/inspect.rs when exact equivalence is proven. Global rule ordinal/transitive-call closure remain in parent Cx.

- `analysis/examples.rs` -> `analysis/examples/mod.rs`, `tables.rs`, `fixtures.rs`, `selectors.rs`, `sequences.rs`, `messages.rs`.
   - public output models73-166 -> tables; shared Checker/node/import/operation traversal168-425 -> mod; fixture/seed checks426-451,687-744 plus fixture helpers -> fixtures; table checks567-686,selector/type/overlap/coverage745-1485 plus selector structures2048-2151/helpers2358-2553 -> selectors; sequences1520-2047 plus SequenceState2152-2167 -> sequences; message checks452-566 and ICU2737-3075 -> messages. Expected error1486-1519 is shared table/sequence policy; leave parent helper. An `examples/fixtures.rs` file is analysis code, distinct from test fixture data.

- `codegen/ir.rs` -> `codegen/ir/mod.rs`, `model.rs`, `build.rs`, `decode_expr.rs`, `decode_effects.rs`, `decode_items.rs`, `decode_rules.rs`, `decode_pages.rs`, `decode_ui.rs`, `decode_fixtures.rs`, `decode_examples.rs`, `literals.rs`.
   - public Ir* carriers50-430, scalar classification734-824, expression/guard/page/example carriers825-1345 -> model (static declarations may stay a larger file); top-level build diagnostics432-613 -> build/literals as applicable; parent Cx614-733 -> mod; program/modules/items1348-1735 -> build; checked expr/message/labels1757-2872 -> decode_expr; async query walker2873-2916 follows expressions; guards/effects2917-3490 -> decode_effects; model/field/param/scenario/CRUD/derive3491-3953 -> decode_items; rule maps/bound capabilities/migrations3954-4404 -> decode_rules; page header/route/names4405-4653 -> decode_pages; UI/form/collection/edit/leaves4654-5480 -> decode_ui; fixtures5481-5748 -> decode_fixtures; suite/table scope/reference decoding5749-6133 -> decode_examples; final anchored CST literal/slice functions6134-6237 -> literals. This leaves the table-to-IR bridge explicit; it does not turn it into a second semantic analyzer.

- `codegen/js.rs` -> `codegen/js/mod.rs`, `writer.rs`, `expressions.rs`, `scalars.rs`, `schema.rs`, `effects.rs`, `pages.rs`, `definition.rs`, `registry.rs`, `packages.rs`.
   - JsLine/Module/output/carriers39-128+Writer129-176 -> writer; Emitter context/driver/import helpers177-416 -> mod; canonical/schema/default/server417-571,1287-1335+one field schema2376-2426 -> schema; expression/call572-745,query1243-1286,message1336-1380 -> expressions; numeric/equality/relational/unary746-1242 plus precedence helpers1836-1867 -> scalars; statement/guards1381-1645+admission helper3023-3038 -> effects; page/UI1646-1835 -> pages; appDefinition identity/metadata1885-2644 excluding helper schemas -> definition; canApp/rule map/handler exports2645-3022 -> registry; package emission3039-3109 -> packages; object/string/identifier escaping helpers belong in writer/mod without producing a new generic utilities package. Preserve gap-helper arithmetic fixes from 9919514 (JS diff1025-1240; tests gap_helper_*1663-1937), exported page descriptors from52ed896, and deterministic imports/source maps. Writer methods are reused by BDD.

- `lsp/server.rs` -> `lsp/server/mod.rs`, `backend.rs`, `protocol.rs`, `session.rs`, `tests.rs`.
    - LanguageAnalysis/StubAnalysis/RealAnalysis139-454 -> backend; public response payloads30-138,position/fix helpers456-521,capabilities/JSON helpers944-1205 -> protocol; OpenDoc/Lifecycle/Server522-943 -> session; run_stdio1206-1245 and exports -> mod; existing unit-test block1247-1525 -> tests with `#[cfg(test)] mod tests`. Preserve lifecycle/version cancellation and client capabilities. Existing transport.rs already correctly isolates byte framing and JSON-RPC; do not fold it into the server simply to shrink directories.

Retain `analysis/catalog.rs`, `cli.rs`, `ide/queries.rs` and `lint/rules.rs` in this chosen tree after reviewing their internal responsibility families. Catalog intake/fallback/signature interpretation is one bounded catalog consumer; CLI command dispatch/platform passthrough remains one command layer; IDE requests share the snapshot; lint rules remain conservative attribution checks. Their medium-file splits were considered and deferred to avoid adding files without demonstrated navigation/change benefit. `format.rs` remains one intertwined spacing/context emitter; `explain.rs` is mainly the 110-entry diagnostic catalog with about 112 lines of rendering/lookup. Lexer/layout remain coherent scanner/layout units with local tests.

`compiler/tests/effects.rs` directly includes the effects source through `#[path]`; migrate it to the actual crate API before splitting that module. Selected analysis/codegen/syntax test child modules group existing outcome families while retaining top-level Cargo targets and setup factories. All other test targets remain at their current names. NodeKey/span identity, deferred diagnostics, fixed-point inference, lossless rollback, deterministic imports/maps, page metadata and production-versus-example module separation must survive the moves. Pure CST inspection helpers can consolidate into `syntax/inspect.rs` only after equivalence checks; keep trust-specific lint/fix interfaces distinct.

Package paths in the next table are relative to `packages/`. Parenthetical sizes describe the `9919514` responsibility review; the size ledger records `b52ad877` committed source. The selected mapping/tree is authoritative for filenames; preserve existing TypeScript entry facades rather than adding redundant new index barrels.

These are responsibility splits, not a line-limit policy. Preserve existing symbol/API names through small barrel exports while moving bodies. Paths below assume existing package owners (12 workspaces); if coordinator groups packages, retain suffixes and ownership. Module-local state remains owned once per call/adapter/run/scope and is passed explicitly; no new service or adapter layer.

| Current path | Desired files and ownership decision |
| --- | --- |
| cloudflare/src/worker/assembly.ts (666) | cloudflare/src/worker/assembly.ts only composes; worker/artifact.ts validates callable/page artifact compatibility and loads page descriptors; worker/invoker.ts binds actual state callable API; delete interimFetch/anonymousIdentity/source-filename app facts/INTERIM_DDL after real interfaces/app descriptor join. Demo DDL belongs in test/fixtures/demo-schema.ts, not shipped generic assembly. Import interface port types from their owner; no structural copies. |
| contracts/src/presentation.ts (1686) | contracts/src/presentation/{context,page,messages,navigation,shell,components,collections,forms,controls,htmx,leaves,groups,overlays,media,panels,settings,review,catalog}.ts with the existing presentation.ts mechanical export facade. Runtime constants/default theme stay one small context.ts. Shared props types use imports from owning modules, not copies. This is a producer shape bundle with genuinely different consumers. |
| contracts/src/state.ts (608) | contracts/src/state/{identity,invocation,query,mutation,commit,storage,migration}.ts behind existing state.ts; branded ids in identity, receipt/context in invocation, writes/history in mutation, batch/outbox/schedule/uniques in commit, port APIs in storage. No runtime behavior added. Wire plain OperationId vs state branded OperationId and duplicate DeliveryStatus must be reconciled intentionally, not hidden by renamed barrels. |
| files/src/upload/index.ts (503) | files/src/upload/{intent,content,validation}.ts + index.ts. Intent authority/retry/frozen args distinct from transfer state and magic-byte validation/digests. Default policy in validation, one expiry/principal helper in upload/shared.ts used by finalize. Preserve partial-transfer resume and append/complete order. |
| interfaces/src/testing.ts (543) | interfaces/src/testing/{identity,http,mcp,uploads,ingress,oauth}.ts behind existing testing.ts; all are test fixture builders and fake ports, excluded from production root export. Common credential fixture created once. |
| services/src/http/client.ts (571) | services/src/http/{client,request,redirects,body,stream}.ts; request owns deadline + combined signal cleanup, redirects owns same-origin/hop/method rules, body owns bounded binary/text reads, stream owns yielded chunks and cancellation cleanup. No independent per-hop deadline. Existing errors/pagination stay. |
| services/src/mail/adapter.ts (675) | services/src/mail/{adapter,request,response}.ts; services/src/completion.ts owns shared assertion and closed completion shape checks; services/src/errors.ts owns generic redaction/deliveryError (current mail/redact). Adapter owns configured http/clock/attachment-size dependencies. Keep request limit check before I/O and original-id reconcile. |
| services/src/judgments/systemone.ts (806) | services/src/judgments/systemone/{adapter,request,response}.ts behind existing systemone.ts. Request frozen question-set/limits separate from response exact noul/choice/score normalization; shared response validator keeps probability/legend/question correspondence in one place. No business thresholds moved into provider. |
| services/src/models/ollama.ts (744) | services/src/models/ollama/{adapter,request,response,run}.ts behind existing ollama.ts. run owns aborter, retained snapshots, sequence, terminal, cancellation flag and settled promise per generation. classifyStreamLine can be response pure helper; no exported mutable session singleton. |
| services/src/media/comfyui.ts (676) | services/src/media/comfyui/{adapter,response,download}.ts behind existing comfyui.ts. Existing media/mapping.ts remains workflow substitution/digest validation; adapter owns HTTP limits/client id/graph/mapping/job ids, response parses authoritative history, download preserves ordering/partial-output completeness. Cancellation remains cancel then reconcile. |
| services/src/scenarios.ts (962) | services/src/testing/scenarios/{schema,mail,models,judgments,media,index}.ts. schema owns strict table/JSON-safe validation and provider scripts; data grouped by provider. Harnesses move from src/{models,judgments,media}/harness.ts and src/ports.ts into src/testing/harness/{mail,models,judgments,media}.ts. Share workerd-safe scenario schema with testkit by package export after service build, not by importing Node harnesses; owner remains services. |
| state/src/mutation/pipeline.ts (818) | state/src/mutation/{pipeline,provisional,candidate,constraints,history}.ts. pipeline retains ordered writes + final invariant pass; provisional owns per-call row/removal overlay and full-model scan; candidate owns defaults/caller patch/hooks/required-known-JSON checks; constraints owns pre-state locks/changed refs/unique staging/invariants; history owns attribution/metadata. Preserve shared one-call overlay and no commits from helper modules. Alternatively keep cohesive pipeline if extraction requires sprawling pass-through arguments, but document helpers first; splitting is warranted by current local helper groups, not size alone. |
| state/src/query/engine.ts (837) | state/src/query/{engine,projection,order,aggregates}.ts; engine retains one revision checkpoint, membership/grant cache, visibility -> projection -> where -> effective order -> overflow; aggregates runs on that same authorized complete set. Projection and order pure helpers; never push limit ahead of visibility. |
| state/src/policy/grants.ts (519) | state/src/policy/{grants,predicate,path}.ts. Grants owns checked/frozen policy and matching; predicate owns validatePredicateShape/collectPredicateFields/evalPredicateForRow/scalar bounds, reused by queries/mutations/migrations; path owns row/metadata path rules/secret checks. SQL's three-valued predicate backend remains separate semantics, not forced through this two-valued evaluator. |
| state/src/migration/transition.ts (793) | state/src/migration/{transition,directives,model-plan,owner-plan}.ts. Transition orchestrates predecessor + table agreement; directives owns duplicate/consumption checks; model plan derives retains/renames/drops/field mappings; owner plan derives install/removal/rename. freshInstallSnapshot separate install.ts if consumer API warrants. |
| state/src/migration/validate.ts (850) | state/src/migration/validation/{index,rows,locks,uniques,references,drops}.ts; validation orchestrates one candidate staged/live view; rows materializes views; locks transports old predicates through mappings; references/uniques/drops evaluate the same candidate set; canonical unique encoding owned once and reused from mutation when equal semantics established. Preserve staged-to-validated fenced progress. |
| state/src/migration/activate.ts (774) | state/src/migration/{activate,evidence,publish,disposition,flip}.ts. activate preserves evidence/table/inventory gates; publish chunk + cursor resume; disposition owner-local drops/expiry and work outcomes; flip installed pointer + invalidation in one fence. No re-entry after publishing and no no-op flip treated as success. |
| state/src/storage/d1.ts (1250) + durable-object.ts (1294) | state/src/storage/{d1,durable-object}.ts remain separate execution adapters. Extract storage/sql/{query,row-codecs,commit-plan,migration-plan}.ts shared pure SQL/binding arrays, row codecs and publish metadata rules; storage/schema.ts canonical DDL. D1 pre-reads + one batch and async error mapping stay D1; DO sync pre-reads + transactionSync stay DO. Fence INSERT first, release-before-claim and dense revisions preserved. No generic database wrapper that erases these atomicity differences. |
| state/src/storage/memory.ts (978) | state/src/testing/{memory-storage,memory-query,memory-probe}.ts, exported only via testing subpath if production consumers need package testing API. Separate SQL-parity three-valued predicate/order functions from mutable state/atomic commit; keep one state owner and validate all constraints before mutation. DO/D1 are not replaced by memory. |
| testkit/src/fixtures/playback.ts (1228) | testkit/src/playback/{handler,body,mail,models,judgments,media}.ts; handler owns hostname routing and seed states once per scope, provider files serve behavior, body owns shared responses/caps/delayed streams. Move script schema to services-owned Worker-safe testing/scenarios/schema.ts and import its built export after build hardening. Keep PlaybackScriptError compatibility as owned mapping if errors differ. Existing playback-worker.ts should become playback/worker.ts; each load must reset state. |
| ui/src/collections.ts (1036) | ui/src/collections/{rows,controls,board,csv-import}.ts behind existing collections.ts; rows owns list/table/query cell rendering; controls owns toolbar/search/filter/order/cursor/export/share; board owns lane presentation; csv-import owns upload/review. Common query bound/context/children helpers small internal.ts. Preserve authorized query runner and cap behavior. |
| ui/src/forms.ts (1038) + controls.ts (1058) | ui/src/forms/{field-binding,field-value,form,actions,outcomes}.ts; ui/src/controls/{scalar,choice,numeric,file,calendar,unit}.ts behind existing controls.ts; existing forms.ts remains its facade. field-binding owns pointer/name/id/error outlets shared by both, field-value owns verbatim draft representation and datetime-local display; unit owns label/validator/readonly hidden-duplicate rendering. This removes forms<->controls import cycle. form owns canonical POST framing/multipart; actions owns sealed-handle/version bound action submission; outcomes owns banners/conflict/current value/delivery messages. No separate browser business state/schema. |
| ui/src/messages.ts (1080) + values/src/icu.ts (1133) | values/src/icu/{descriptor,parser,validation,render,number}.ts and values/src/locale.ts are canonical exact typed semantics. UI gets ui/src/messages.ts for caption/factory/context bridge and ui/src/format.ts for form/row display adaptation, consuming values. Current types/profiles/numbering behavior differ: UI localizes non-Latin digits, values explicitly uses Latin digits for reproducible exact rendering; UI's string runtime descriptors are not the same as values typed bound descriptors. Share after equivalence matrix/design decision, not a textual deletion. Keep localized display vs canonical wire distinct, and preserve resolved variant locale. |
| ui/src/navigation.ts (709) | ui/src/navigation/{discovery,controls}.ts behind existing navigation.ts; discovery pure shaping of already-admitted page outcomes, controls existing breadcrumbs/button/menu/navbar/dock/megamenu/pagination/theme presentation. Dispatcher owns actual admission calls. |
| values/src/schema.ts (1797) | values/src/schema/{descriptor,normalize,validate,bounds,omission}.ts behind existing schema.ts. Descriptor normalized type shapes, normalize compile/config-time closed schema checks; validate caller value/operation input and recursive contract/union traversal; bounds owns normalized bound comparison; omission owns UPDATE_OMITTED distinction. Keep arrays/default/required/nullable creation-vs-update evaluation order. |
| values/src/wire.ts (1761) | values/src/wire/{decode,encode,errors}.ts behind existing wire.ts. Recursive decode closed shape/violation collection distinct from encode canonical no-secret export; errors owns shared pointer/collector formatting. Keep named/scalar/dynamic dispatch and invocation wire type evidence consistent; avoid separate format registry. |
| values/src/temporal.ts (554) | values/src/temporal/{calendar,duration,instant}.ts behind existing temporal.ts; calendar pure civil algorithms/date ranges and half-open iteration, duration checked bigint arithmetic, instant checked datetime parse/operator bounds. Existing timezone.ts owns wall-time fold/gap conversion. |
| work/src/kernel/commands.ts (1005) | work/src/kernel/commands/{dispatch,occurrence,schedule,every,arguments}.ts behind existing commands.ts. Shared arguments/conditional-row write helpers, independent command groups; commands.ts only assembles nine WORK_SYSTEM_COMMANDS. Schedule retains lineage/scope embedding/supersession together. Each command stages to the one state registry. |
| work/src/kernel/tables.ts (578) | work/src/kernel/tables/{dispatch,occurrence,schedule,every,supersession,row}.ts behind existing tables.ts; row owns JSON-safe validation/common metadata factory/version bump and typed guards; separate payload constructors/readers/query specs own each table. Avoid moving tables into shared contracts: they are implementation storage shapes. |

Additional cohesive modules stay where they are: identity account/auth/session/team mechanisms (all <250 except memory testing), interfaces protocol route modules (MCP 439, OAuth 473, uploads 405) have actual protocol responsibilities and don't need new packages; existing shared body/auth/envelope helpers already separate; select interfaces/http/presentation.ts to share full/partial page context construction, with its owning test and no new authority; ui leaf/group/overlay/panel/media/settings/review factories are stable component families; values scalar arithmetic/equality/type parser/string/timezone and work intent/dispatch/event/receipt/recovery/schedule mechanisms remain cohesive.

Ports/test boundaries: files/src/ports.ts and work/src/ports.ts currently combine public seam interfaces with many TestOnly classes; retain production interfaces and assertSafeBlobKey in ports.ts or storage/key.ts, move doubles to src/testing.ts. services/src/ports.ts retain only contracts, production defaults in runtime.ts (Web APIs as appropriate), mail harness in testing/harness/mail.ts, fixedClock/sequentialIds/fixedAttachmentSizes in testing/helpers.ts. Identity testing.ts (421) is a single memory IdentityStore factory; keep one test-only store state owner there and move its mail/clock fixture helpers into testing/helpers.ts. Its explicit testing export is useful and should stay excluded from root. Contracts default constants are runtime imports today despite “type-only” descriptions; retain one canonical constant definition and report real runtime dependency.

### Large tests and fixture assets

The selected tree retains existing package test filenames. The following partitions describe verified outcome boundaries and **unselected** future test-layout alternatives; they do not add leaves to the desired tree. Keep shared setup factories and cross-feature journeys. Separate test files only if later change/navigation evidence warrants updating this tree; do not mechanically mirror helper files or divide one atomic scenario across independent state.

- state/test/storage/conformance.ts (2622): storage/conformance/{records,query,fence,receipts,effects,migration,index}.ts; one suite registrar applies EVERY group unchanged to real D1, real DO and memory. Real race/raw rollback tests remain in d1.test.ts/do.test.ts. do-test-worker.js remains workerd bridge fixture to real DO source, never a production API. Ensure each test gets a fresh factory instance, not group-level singleton.
- state/test/migration/stage.test.ts (1319): stage/rows.test.ts, stage/validation.test.ts, stage/references.test.ts, stage/locks.test.ts, stage/drops.test.ts only as existing phases warrant; stage/fixtures.ts same shared model/store builders. activate.test.ts (1067) -> activation/evidence.test.ts, activation/publish.test.ts, activation/disposition.test.ts. Existing resume.test.ts (369), invalidate.test.ts (214), transition.test.ts (620) remain coherent transition cases; transition may separate predecessor vs model/owner mapping if lookup helps. invoke.test.ts (670) -> invoke/commit.test.ts, invoke/replay.test.ts, invoke/retry.test.ts but all exercise canonical invoke, not helpers. admission.test.ts (523) is one gate matrix and may stay.
- ui/test/collections.test.ts (2204): collections/rows.test.ts, controls.test.ts, board.test.ts, csv-import.test.ts; form (1336) separates field binding/widget/multipart from form/action/outcome behavior; controls.test.ts (961) scalar/choice/numeric/file/calendar suites. navigation.test.ts (1386) discovery vs controls, shell.test.ts (1113) document/account/discovery/partial behavior. journeys.test.ts (774) stays cross-feature authority/locale/error journeys. DOM harness happy-dom and descriptors fixture stay test/support, preserving theme-class audits and HTMX swaps. Do not remove themes.css (359), nine daisyUI theme pins, density/system-mode behavior or daisyUI exact dependency.
- interfaces/test/uploads.test.ts (883) -> uploads/auth.test.ts, intent.test.ts, content.test.ts, finalize.test.ts and routes.test.ts with common support; mcp-server.test.ts (789) authentication/protocol/tools/invoke as independent routes. integration-lifecycle.test.ts (754) groups auth revoke, role revoke, file upload, ingress, principal isolation; integration-parity.test.ts (844) remains dedicated HTTP/MCP differential assertion families (inputs/discovery/rejection/replay). Their invokers/kernels are doubles: preserve clear “adapter parity, not state join” evidence labels. http-pages.test.ts (546), oauth.test.ts (536) may retain protocol matrices with shared fixtures; splitting not necessary for size alone.
- services/test/scenarios.test.ts (998) and testkit/test/playback.test.ts (1036): provider directories plus one catalog-wide differential registrar; 41 tables must remain covered, no orphan seed/fake server replacement. models (646), judgments (667), media (764) group request mapping, response classification, streaming/cancel/reconcile where those are distinct. Mail (463) coherent adapter matrix may stay. HTTP client tests retain timeout/body/redirect order.
- values/test/schema.test.ts (1012): descriptor normalization vs value and operation validation; wire.test.ts (940): decoding/encoding/rich wire groups or retained type-family matrix with common ordered violation helper. ICU tests (530) keep accept/reject/exactness profile matrices. decimal-oracle.test.ts (248) retains seeded Decimal.js 38-digit half-even independent oracle; never replace by self-produced expected output. conformance/v1/{README.md,values.json} remain versioned consumer corpus; values.json includes 1050 lines of wire/builtin/operation samples with exact representations, not code to translate or duplicate in Rust. Preserve canonical and invalid samples/violation order and published-version distinction.
- work/test/kernel-commands.test.ts (1332): dispatch/occurrence/schedule/every command suites with test/support fixtures; all retain conditional expectedVersion/fence stage assertions, twins converging, late canceled guards and unknown effects. observation.test.ts (590) remains field-grant/content-availability matrix.
- JSON fixtures: identity revoked-session and two-user-team preserve active membership, role ceiling, token hash, revocation facts; interfaces action-handle/business-error/mutation-envelope/upload-intent preserve framing and file transfer metadata. They move with owning test suites; never to app config. smoke-worker.mjs, scope-worker.mjs are generic local-engine wiring fixtures and remain test-only. ui/test/fixtures/descriptors.ts is descriptor contract fixture, not generated app identity; ui/test/harness.ts DOM dependency stays test-only.

The [editor client](../editors/vscode/src/client.ts) combines about 130 lines of temporary ambient host declarations, byte framing, pending-request/process lifecycle and diagnostic conversion. Retain `client.ts` as the public client coordinator; proposed `src/protocol.ts` owns JSON-RPC types and UTF-8 framing, and `src/diagnostics.ts` owns validation/conversion. Keep process, pending IDs, shutdown timers and the once-only exit guard together. Do not add a shared runtime package or another process. The existing future `vscode-languageclient` adoption is unresolved: if adopted, retire custom framing rather than splitting then maintaining both. Remove temporary declarations only with real host types/build agreement. Update extension compilation inputs, release archive and lane-01 check together.

The 143,148-byte, 5,098-line [TextMate grammar](../editors/vscode/syntaxes/can.tmLanguage.json) already has 53 named rule families and context-sensitive rule order. Keep one shipped JSON grammar; mechanical fragmentation would add generation without a demonstrated owner boundary. The 35,335-byte, 267-line [highlighting checker](../editors/vscode/check-highlighting.cjs) combines engine setup, lexical/context probes, corpus traversal and theme checks. Proposed sibling `test/engine.cjs`, `test/syntax.cjs`, `test/corpus.cjs` and `test/palette.cjs` can share the existing engine while the current command remains a coordinator. Declare portable TextMate/Oniguruma dependencies and remove reliance on an installed Cursor tree only during separately authorized implementation; historical probes keep their captured environment.

The 67,112-byte, 1,348-line [Python parser](../tools/can_parser.py) is production tooling with separate tests in `test_can_parser.py` (503 lines), not an implementation swollen by embedded tests. Its `Cursor` owns token/type/expression parsing; `Parser` owns source/section/declaration/execution/example/UI/migration parsing. Avoid decomposing a temporary parallel parser into a new Python package. The retirement gate is: extract positive/negative syntax and physical-location expectations into Rust syntax fixtures, decide drift against current GRAMMAR, migrate CI and README/tool commands, then retire **both** parser and boundary suite. Retain `jev.py` and `test_jev.py`; they have an independent research purpose. References to missing `migrate_given_invariants.py` and its test in tools README are stale instructions, not inventoried live files; repair those docs when retiring the parser. No reinstatement of that obsolete migration tool is proposed.

Large DESIGN/GRAMMAR/DECISIONS/REQUIREMENTS/EVALUATION documents have existing authority, semantic sections and linked examples. Keep their current filenames and authority; a navigable section index is preferable to multiple drifting normative copies. Frozen copies remain immutable. Current root README/developer setup/B1 logs contain older scaffold/blocker statements despite later compiler/runtime source; this plan records the discrepancy and does not treat those statements as current implementation proof.

The pinned draft inventory is 49 application `.can` files plus three shared sources, 49 companion requirements plus five supporting Markdown files, and 41 handwritten `.mjs` witnesses. Thirty-one targets contain `appDefinition`, `canApp` and deferred `exampleFixtures`; ten are frontend-only slices (CanDo, CanInvoice, CanLearn, CanMember, CanPropose, CanReception, CanReport, CanStats, CanSuccess, CanTrade). Retain all 148 paths in their independent repository. Shared Employees/Locations/Suppliers and selected Can owners remain the composition boundary; importing an owner does not grant authority.

All 41 current, 21 frozen and six proposal MJS targets were parsed structurally with TypeScript (68 files, 547,654 AST nodes; zero syntax diagnostics). Imports, function ranges, registry keys and fixture-return shapes were inspected. Syntax acceptance is not module resolution or executed behavior. For current CanRent (10,760 lines), helpers are roughly lines 134–705; appDefinition begins at 1058 (models 1145, pages 3532); canApp is 3557–8013; renderers 8025–9793; exampleFixtures begins at 9814. Frozen Rent has the same broad boundaries at 8,885 lines. Reservation/catalog/fulfillment/reporting and migration/reconciliation identities explain size; do not invent app wrappers or platform engines to shorten it.

Most older full targets return flat fixture names plus `examples`, whereas current DESIGN §13 expects `{fixtures,examples}`; newer complex targets use the wrapper. Preserve this as a producer/draft correspondence gap. Runtime target bodies and deferred test recipes are conceptually separate outputs; a future compiler may emit multiple modules and a separate test artifact without reorganizing the handwritten witness by arbitrary line counts. Frozen targets stay unchanged. The complete desired tree does not implement these proposed APIs or move draft authorship into the parent repository.

## Affected consumers and implementation obligations

Any later refactor must update each changed import and its direct consumers as one reviewed change. Preserve public Rust paths with module re-exports, TypeScript published exports with small facades, diagnostic codes/spans, generated callable/module/export names, schema/wire fixtures, catalog identities and inline examples. Facades are compatibility exports inside existing owners, not new deployment adapters.

| Area | Wiring that must move with implementation |
| --- | --- |
| Rust modules | `lib.rs`, parent `mod.rs` declarations, Rust integration imports, `cli.rs`, LSP/IDE/lint callers; Cargo remains one crate. Module files use `snake_case`; no simultaneous `foo.rs` and `foo/mod.rs`. Child visibility must preserve private pass state rather than expose it publicly. Retained top-level test targets must explicitly include their `tests/<target>/` child files with suitable `#[path]` declarations; Cargo will not discover those cases by directory existence alone, and a bare `mod` in a target root resolves beside the root. |
| TypeScript libraries | Package `index.ts` barrels, `exports`/`main`/`types`/`files`, producer tsconfigs and path mappings, direct source `.ts` imports versus NodeNext `.js` emit imports, root `package.json`/`bun.lock`, package scripts, root check/test inclusion and test runner ownership. Update only affected wiring; no source proposal silently changes publication policy. |
| Generated consumers | Rust catalog intake and values `scripts/emit-catalog.mjs`; emitted `@canlang/stdlib`/`@canlang/ui` specifiers; platform module staging and loader tests; testkit artifact loader/runner; source maps, production modules and separate example modules. Keep generated outputs outside tracked source unless they are intentionally preserved evidence. |
| Runtime joins | State invocation/admission/mutation permissions and replay; worker assembly dependency injection; identity and HTTP/MCP parity; file upload/receiving-owner finalization; work delivery/observation/reconciliation; provider fixtures versus live bindings. File moves must not invent a transaction across owners or reorder guards/effects. |
| Cross-package tests | Root Vitest currently owns contracts/cloudflare/testkit/integration; producer Node tests retain their own runners. Root typecheck excludes playback tests pending producer strictness joins. Consumer coverage must widen explicitly when integration changes, not be assumed from a root green check. |
| End-to-end wiring | `tests/e2e/fixtures/artifact-loader.ts` reads exact UI/identity/contracts dist layouts, supplies aliases without rewriting code and witnesses TeamTasks source bytes. Handbuilt fixture remains a separately labeled diagnostic baseline until real compiled-artifact journeys replace it; neither it nor readiness tests demonstrate B1 completion. |
| Build/release definitions | Existing lane workflows/path filters, integration/e2e/B1 joins, release pack list (contracts, cloudflare, testkit, state, values), Rust binary and editor archive payload. If production imports change, include the transitive workerd bundle in later runtime verification; lexical static-import scanning alone misses dynamic imports. No workflow changes are authorized by this plan. |

Future verification should be proportional to actual change: affected producer checks, compiler pass/integration tests, unchanged conformance vectors and source-span expectations, then the connected artifact/runtime journey when its sources changed. Repeated full builds are not required to maintain this document.

## Complete desired tree and current-file coverage

This is **one** selected desired tree. It includes explicit filenames, retained historical evidence and the independent draft contents, not `...` or directory-only placeholders. Existing paths not listed in the change/decomposition table are retained **at the same path**, with the same ownership. The table specifies every exception, split input, consolidation and proposed retirement gate. Each input file retains a facade/module coordinator unless a different destination is explicitly recorded. New leaf files are proposals, not APIs that already exist.

Tree annotations: `+` means a proposed new file; `←` identifies a moved current file; `[G]` means tracked generated evidence or media retained for provenance; `[H]` means frozen historical source/evidence; `[D]` means contents owned by the pinned draft submodule. Retained current source has no marker. Untracked/ignored outputs are not tree leaves. `draft/` is a parent gitlink, not a new parent package.

| Current input | Selected disposition and exact destinations |
| --- | --- |
| `compiler/src/analysis/effects.rs` | split: `compiler/src/analysis/effects/mod.rs`<br>`compiler/src/analysis/effects/tables.rs`<br>`compiler/src/analysis/effects/declarations.rs`<br>`compiler/src/analysis/effects/rules.rs`<br>`compiler/src/analysis/effects/handlers.rs`<br>`compiler/src/analysis/effects/statements.rs`<br>`compiler/src/analysis/effects/descriptions.rs`<br>`compiler/src/analysis/effects/migrations.rs` |
| `compiler/src/analysis/examples.rs` | split: `compiler/src/analysis/examples/mod.rs`<br>`compiler/src/analysis/examples/tables.rs`<br>`compiler/src/analysis/examples/fixtures.rs`<br>`compiler/src/analysis/examples/selectors.rs`<br>`compiler/src/analysis/examples/sequences.rs`<br>`compiler/src/analysis/examples/messages.rs` |
| `compiler/src/analysis/mod.rs` | consolidate-pure-helpers: `compiler/src/analysis/mod.rs`<br>`compiler/src/syntax/inspect.rs` |
| `compiler/src/analysis/resolve.rs` | split: `compiler/src/analysis/resolve/mod.rs`<br>`compiler/src/analysis/resolve/tables.rs`<br>`compiler/src/analysis/resolve/modules.rs`<br>`compiler/src/analysis/resolve/declarations.rs`<br>`compiler/src/analysis/resolve/imports.rs`<br>`compiler/src/analysis/resolve/scopes.rs`<br>`compiler/src/analysis/resolve/types.rs`<br>`compiler/src/analysis/resolve/bodies.rs`<br>`compiler/src/analysis/resolve/expressions.rs`<br>`compiler/src/analysis/resolve/cycles.rs` |
| `compiler/src/analysis/types.rs` | split: `compiler/src/analysis/types/mod.rs`<br>`compiler/src/analysis/types/model.rs`<br>`compiler/src/analysis/types/declarations.rs`<br>`compiler/src/analysis/types/expressions.rs`<br>`compiler/src/analysis/types/members.rs`<br>`compiler/src/analysis/types/operators.rs`<br>`compiler/src/analysis/types/narrowing.rs`<br>`compiler/src/analysis/types/constructs.rs`<br>`compiler/src/analysis/types/queries.rs`<br>`compiler/src/analysis/types/calls.rs`<br>`compiler/src/analysis/types/overloads.rs`<br>`compiler/src/analysis/types/statements.rs`<br>`compiler/src/analysis/types/mutations.rs`<br>`compiler/src/analysis/types/effect_calls.rs`<br>`compiler/src/analysis/types/scenarios.rs`<br>`compiler/src/analysis/types/schemas.rs`<br>`compiler/src/analysis/types/rules.rs`<br>`compiler/src/analysis/types/context.rs`<br>`compiler/src/analysis/types/ui.rs`<br>`compiler/src/analysis/types/fixtures.rs`<br>`compiler/src/analysis/types/literals.rs` |
| `compiler/src/codegen/ir.rs` | split: `compiler/src/codegen/ir/mod.rs`<br>`compiler/src/codegen/ir/model.rs`<br>`compiler/src/codegen/ir/build.rs`<br>`compiler/src/codegen/ir/decode_expr.rs`<br>`compiler/src/codegen/ir/decode_effects.rs`<br>`compiler/src/codegen/ir/decode_items.rs`<br>`compiler/src/codegen/ir/decode_rules.rs`<br>`compiler/src/codegen/ir/decode_pages.rs`<br>`compiler/src/codegen/ir/decode_ui.rs`<br>`compiler/src/codegen/ir/decode_fixtures.rs`<br>`compiler/src/codegen/ir/decode_examples.rs`<br>`compiler/src/codegen/ir/literals.rs` |
| `compiler/src/codegen/js.rs` | split: `compiler/src/codegen/js/mod.rs`<br>`compiler/src/codegen/js/writer.rs`<br>`compiler/src/codegen/js/expressions.rs`<br>`compiler/src/codegen/js/scalars.rs`<br>`compiler/src/codegen/js/schema.rs`<br>`compiler/src/codegen/js/effects.rs`<br>`compiler/src/codegen/js/pages.rs`<br>`compiler/src/codegen/js/definition.rs`<br>`compiler/src/codegen/js/registry.rs`<br>`compiler/src/codegen/js/packages.rs` |
| `compiler/src/ide/queries.rs` | consolidate-pure-helpers: `compiler/src/ide/queries.rs`<br>`compiler/src/syntax/inspect.rs` |
| `compiler/src/lint/rules.rs` | consolidate-pure-helpers: `compiler/src/lint/rules.rs`<br>`compiler/src/syntax/inspect.rs` |
| `compiler/src/lsp/server.rs` | split: `compiler/src/lsp/server/mod.rs`<br>`compiler/src/lsp/server/backend.rs`<br>`compiler/src/lsp/server/protocol.rs`<br>`compiler/src/lsp/server/session.rs`<br>`compiler/src/lsp/server/tests.rs` |
| `compiler/src/syntax/parser.rs` | split: `compiler/src/syntax/parser/mod.rs`<br>`compiler/src/syntax/parser/cursor.rs`<br>`compiler/src/syntax/parser/builder.rs`<br>`compiler/src/syntax/parser/recovery.rs`<br>`compiler/src/syntax/parser/modules.rs`<br>`compiler/src/syntax/parser/expressions.rs`<br>`compiler/src/syntax/parser/types.rs`<br>`compiler/src/syntax/parser/attributes.rs`<br>`compiler/src/syntax/parser/given.rs`<br>`compiler/src/syntax/parser/when.rs`<br>`compiler/src/syntax/parser/examples.rs`<br>`compiler/src/syntax/parser/ui.rs`<br>`compiler/src/syntax/parser/migrations.rs` |
| `compiler/tests/analysis.rs` | retain target and split cases: `compiler/tests/analysis.rs`<br>`compiler/tests/analysis/catalog.rs`<br>`compiler/tests/analysis/resolve.rs`<br>`compiler/tests/analysis/types.rs`<br>`compiler/tests/analysis/corpus.rs`<br>`compiler/tests/analysis/support.rs` |
| `compiler/tests/codegen.rs` | retain target and split cases: `compiler/tests/codegen.rs`<br>`compiler/tests/codegen/support.rs`<br>`compiler/tests/codegen/goldens.rs`<br>`compiler/tests/codegen/scalars.rs`<br>`compiler/tests/codegen/items.rs`<br>`compiler/tests/codegen/pages.rs`<br>`compiler/tests/codegen/examples.rs`<br>`compiler/tests/codegen/capabilities.rs`<br>`compiler/tests/codegen/sourcemap.rs` |
| `compiler/tests/syntax.rs` | retain target and split cases: `compiler/tests/syntax.rs`<br>`compiler/tests/syntax/lexer.rs`<br>`compiler/tests/syntax/layout.rs`<br>`compiler/tests/syntax/parser.rs`<br>`compiler/tests/syntax/corpus.rs` |
| `editors/vscode/check-highlighting.cjs` | split-with-existing-entry: `editors/vscode/check-highlighting.cjs`<br>`editors/vscode/test/engine.cjs`<br>`editors/vscode/test/syntax.cjs`<br>`editors/vscode/test/corpus.cjs`<br>`editors/vscode/test/palette.cjs` |
| `editors/vscode/src/client.ts` | split-with-existing-entry: `editors/vscode/src/client.ts`<br>`editors/vscode/src/protocol.ts`<br>`editors/vscode/src/diagnostics.ts` |
| `packages/cloudflare/src/runtime/artifact.ts` | move: `packages/cloudflare/src/build/artifact.ts` |
| `packages/cloudflare/src/runtime/context.ts` | replace-interim: `packages/state/src/invocation/context.ts` |
| `packages/cloudflare/src/runtime/invoke.ts` | replace-interim: `packages/state/src/invocation/invoke.ts` |
| `packages/cloudflare/src/runtime/modules.ts` | move: `packages/cloudflare/src/build/modules.ts` |
| `packages/cloudflare/src/runtime/stdlib.ts` | replace-interim: `packages/state/src/builtins.ts`<br>`packages/stdlib/src/index.ts` |
| `packages/cloudflare/src/worker/assembly.ts` | split-with-existing-entry: `packages/cloudflare/src/worker/assembly.ts`<br>`packages/cloudflare/src/worker/artifact.ts`<br>`packages/cloudflare/src/worker/invoker.ts`<br>`packages/cloudflare/test/fixtures/demo-schema.ts` |
| `packages/contracts/src/presentation.ts` | split-with-existing-entry: `packages/contracts/src/presentation.ts`<br>`packages/contracts/src/presentation/context.ts`<br>`packages/contracts/src/presentation/page.ts`<br>`packages/contracts/src/presentation/messages.ts`<br>`packages/contracts/src/presentation/navigation.ts`<br>`packages/contracts/src/presentation/shell.ts`<br>`packages/contracts/src/presentation/components.ts`<br>`packages/contracts/src/presentation/collections.ts`<br>`packages/contracts/src/presentation/forms.ts`<br>`packages/contracts/src/presentation/controls.ts`<br>`packages/contracts/src/presentation/htmx.ts`<br>`packages/contracts/src/presentation/leaves.ts`<br>`packages/contracts/src/presentation/groups.ts`<br>`packages/contracts/src/presentation/overlays.ts`<br>`packages/contracts/src/presentation/media.ts`<br>`packages/contracts/src/presentation/panels.ts`<br>`packages/contracts/src/presentation/settings.ts`<br>`packages/contracts/src/presentation/review.ts`<br>`packages/contracts/src/presentation/catalog.ts` |
| `packages/contracts/src/state.ts` | split-with-existing-entry: `packages/contracts/src/state.ts`<br>`packages/contracts/src/state/identity.ts`<br>`packages/contracts/src/state/invocation.ts`<br>`packages/contracts/src/state/query.ts`<br>`packages/contracts/src/state/mutation.ts`<br>`packages/contracts/src/state/commit.ts`<br>`packages/contracts/src/state/storage.ts`<br>`packages/contracts/src/state/migration.ts` |
| `packages/files/src/ports.ts` | split-with-existing-entry: `packages/files/src/ports.ts`<br>`packages/files/src/testing.ts`<br>`packages/files/src/storage/key.ts` |
| `packages/files/src/upload/fs-blob-store.ts` | move: `packages/files/src/storage/fs.ts` |
| `packages/files/src/upload/index.ts` | split-with-existing-entry: `packages/files/src/upload/index.ts`<br>`packages/files/src/upload/intent.ts`<br>`packages/files/src/upload/content.ts`<br>`packages/files/src/upload/validation.ts`<br>`packages/files/src/upload/shared.ts` |
| `packages/identity/src/testing.ts` | split-with-existing-entry: `packages/identity/src/testing.ts`<br>`packages/identity/src/testing/helpers.ts` |
| `packages/interfaces/src/http/pages.ts` | split-with-existing-entry: `packages/interfaces/src/http/pages.ts`<br>`packages/interfaces/src/http/presentation.ts`; new owning test: `packages/interfaces/test/http-presentation.test.ts`. Constructor/test currently exist only in the observed uncommitted overlay; preserve the full/partial dispatcher callers. |
| `packages/interfaces/src/testing.ts` | split-with-existing-entry: `packages/interfaces/src/testing.ts`<br>`packages/interfaces/src/testing/identity.ts`<br>`packages/interfaces/src/testing/http.ts`<br>`packages/interfaces/src/testing/mcp.ts`<br>`packages/interfaces/src/testing/uploads.ts`<br>`packages/interfaces/src/testing/ingress.ts`<br>`packages/interfaces/src/testing/oauth.ts` |
| `packages/services/src/http/client.ts` | split-with-existing-entry: `packages/services/src/http/client.ts`<br>`packages/services/src/http/request.ts`<br>`packages/services/src/http/redirects.ts`<br>`packages/services/src/http/body.ts`<br>`packages/services/src/http/stream.ts` |
| `packages/services/src/judgments/harness.ts` | move: `packages/services/src/testing/harness/judgments.ts` |
| `packages/services/src/judgments/systemone.ts` | split-with-existing-entry: `packages/services/src/judgments/systemone.ts`<br>`packages/services/src/judgments/systemone/adapter.ts`<br>`packages/services/src/judgments/systemone/request.ts`<br>`packages/services/src/judgments/systemone/response.ts` |
| `packages/services/src/mail/adapter.ts` | split-with-existing-entry: `packages/services/src/mail/adapter.ts`<br>`packages/services/src/mail/request.ts`<br>`packages/services/src/mail/response.ts`<br>`packages/services/src/completion.ts` |
| `packages/services/src/mail/redact.ts` | move: `packages/services/src/errors.ts` |
| `packages/services/src/media/comfyui.ts` | split-with-existing-entry: `packages/services/src/media/comfyui.ts`<br>`packages/services/src/media/comfyui/adapter.ts`<br>`packages/services/src/media/comfyui/response.ts`<br>`packages/services/src/media/comfyui/download.ts` |
| `packages/services/src/media/harness.ts` | move: `packages/services/src/testing/harness/media.ts` |
| `packages/services/src/models/harness.ts` | move: `packages/services/src/testing/harness/models.ts` |
| `packages/services/src/models/ollama.ts` | split-with-existing-entry: `packages/services/src/models/ollama.ts`<br>`packages/services/src/models/ollama/adapter.ts`<br>`packages/services/src/models/ollama/request.ts`<br>`packages/services/src/models/ollama/response.ts`<br>`packages/services/src/models/ollama/run.ts` |
| `packages/services/src/ports.ts` | split-with-existing-entry: `packages/services/src/ports.ts`<br>`packages/services/src/runtime.ts`<br>`packages/services/src/testing/helpers.ts`<br>`packages/services/src/testing/harness/mail.ts` |
| `packages/services/src/scenarios.ts` | split-with-existing-entry: `packages/services/src/scenarios.ts`<br>`packages/services/src/testing/scenarios/schema.ts`<br>`packages/services/src/testing/scenarios/mail.ts`<br>`packages/services/src/testing/scenarios/models.ts`<br>`packages/services/src/testing/scenarios/judgments.ts`<br>`packages/services/src/testing/scenarios/media.ts`<br>`packages/services/src/testing/scenarios/index.ts` |
| `packages/state/src/migration/activate.ts` | split-with-existing-entry: `packages/state/src/migration/activate.ts`<br>`packages/state/src/migration/evidence.ts`<br>`packages/state/src/migration/publish.ts`<br>`packages/state/src/migration/disposition.ts`<br>`packages/state/src/migration/flip.ts` |
| `packages/state/src/migration/transition.ts` | split-with-existing-entry: `packages/state/src/migration/transition.ts`<br>`packages/state/src/migration/directives.ts`<br>`packages/state/src/migration/model-plan.ts`<br>`packages/state/src/migration/owner-plan.ts` |
| `packages/state/src/migration/validate.ts` | split-with-existing-entry: `packages/state/src/migration/validate.ts`<br>`packages/state/src/migration/validation/index.ts`<br>`packages/state/src/migration/validation/rows.ts`<br>`packages/state/src/migration/validation/locks.ts`<br>`packages/state/src/migration/validation/uniques.ts`<br>`packages/state/src/migration/validation/references.ts`<br>`packages/state/src/migration/validation/drops.ts` |
| `packages/state/src/mutation/pipeline.ts` | split-with-existing-entry: `packages/state/src/mutation/pipeline.ts`<br>`packages/state/src/mutation/provisional.ts`<br>`packages/state/src/mutation/candidate.ts`<br>`packages/state/src/mutation/constraints.ts`<br>`packages/state/src/mutation/history.ts` |
| `packages/state/src/policy/grants.ts` | split-with-existing-entry: `packages/state/src/policy/grants.ts`<br>`packages/state/src/policy/predicate.ts`<br>`packages/state/src/policy/path.ts` |
| `packages/state/src/query/engine.ts` | split-with-existing-entry: `packages/state/src/query/engine.ts`<br>`packages/state/src/query/projection.ts`<br>`packages/state/src/query/order.ts`<br>`packages/state/src/query/aggregates.ts` |
| `packages/state/src/storage/d1.ts` | split-with-existing-entry: `packages/state/src/storage/d1.ts`<br>`packages/state/src/storage/sql/query.ts`<br>`packages/state/src/storage/sql/row-codecs.ts`<br>`packages/state/src/storage/sql/commit-plan.ts`<br>`packages/state/src/storage/sql/migration-plan.ts`<br>`packages/state/src/storage/schema.ts` |
| `packages/state/src/storage/durable-object.ts` | split-with-existing-entry: `packages/state/src/storage/durable-object.ts`<br>`packages/state/src/storage/sql/query.ts`<br>`packages/state/src/storage/sql/row-codecs.ts`<br>`packages/state/src/storage/sql/commit-plan.ts`<br>`packages/state/src/storage/sql/migration-plan.ts`<br>`packages/state/src/storage/schema.ts` |
| `packages/state/src/storage/memory.ts` | move: `packages/state/src/testing/memory-storage.ts`<br>`packages/state/src/testing/memory-query.ts`<br>`packages/state/src/testing/memory-probe.ts` |
| `packages/testkit/src/fixtures/playback-worker.ts` | move: `packages/testkit/src/playback/worker.ts` |
| `packages/testkit/src/fixtures/playback.ts` | split-with-existing-entry: `packages/testkit/src/fixtures/playback.ts`<br>`packages/testkit/src/playback/handler.ts`<br>`packages/testkit/src/playback/body.ts`<br>`packages/testkit/src/playback/mail.ts`<br>`packages/testkit/src/playback/models.ts`<br>`packages/testkit/src/playback/judgments.ts`<br>`packages/testkit/src/playback/media.ts`<br>`packages/services/src/testing/scenarios/schema.ts` |
| `packages/ui/src/collections.ts` | split-with-existing-entry: `packages/ui/src/collections.ts`<br>`packages/ui/src/collections/rows.ts`<br>`packages/ui/src/collections/controls.ts`<br>`packages/ui/src/collections/board.ts`<br>`packages/ui/src/collections/csv-import.ts`<br>`packages/ui/src/collections/internal.ts` |
| `packages/ui/src/controls.ts` | split-with-existing-entry: `packages/ui/src/controls.ts`<br>`packages/ui/src/controls/scalar.ts`<br>`packages/ui/src/controls/choice.ts`<br>`packages/ui/src/controls/numeric.ts`<br>`packages/ui/src/controls/file.ts`<br>`packages/ui/src/controls/calendar.ts`<br>`packages/ui/src/controls/unit.ts` |
| `packages/ui/src/forms.ts` | split-with-existing-entry: `packages/ui/src/forms.ts`<br>`packages/ui/src/forms/field-binding.ts`<br>`packages/ui/src/forms/field-value.ts`<br>`packages/ui/src/forms/form.ts`<br>`packages/ui/src/forms/actions.ts`<br>`packages/ui/src/forms/outcomes.ts` |
| `packages/ui/src/messages.ts` | split-with-existing-entry: `packages/ui/src/messages.ts`<br>`packages/ui/src/format.ts`<br>`packages/values/src/icu/render.ts`<br>`packages/values/src/locale.ts` |
| `packages/ui/src/navigation.ts` | split-with-existing-entry: `packages/ui/src/navigation.ts`<br>`packages/ui/src/navigation/discovery.ts`<br>`packages/ui/src/navigation/controls.ts` |
| `packages/values/src/icu.ts` | split-with-existing-entry: `packages/values/src/icu.ts`<br>`packages/values/src/icu/descriptor.ts`<br>`packages/values/src/icu/parser.ts`<br>`packages/values/src/icu/validation.ts`<br>`packages/values/src/icu/render.ts`<br>`packages/values/src/icu/number.ts` |
| `packages/values/src/schema.ts` | split-with-existing-entry: `packages/values/src/schema.ts`<br>`packages/values/src/schema/descriptor.ts`<br>`packages/values/src/schema/normalize.ts`<br>`packages/values/src/schema/validate.ts`<br>`packages/values/src/schema/bounds.ts`<br>`packages/values/src/schema/omission.ts` |
| `packages/values/src/temporal.ts` | split-with-existing-entry: `packages/values/src/temporal.ts`<br>`packages/values/src/temporal/calendar.ts`<br>`packages/values/src/temporal/duration.ts`<br>`packages/values/src/temporal/instant.ts` |
| `packages/values/src/wire.ts` | split-with-existing-entry: `packages/values/src/wire.ts`<br>`packages/values/src/wire/decode.ts`<br>`packages/values/src/wire/encode.ts`<br>`packages/values/src/wire/errors.ts` |
| `packages/work/src/kernel/commands.ts` | split-with-existing-entry: `packages/work/src/kernel/commands.ts`<br>`packages/work/src/kernel/commands/dispatch.ts`<br>`packages/work/src/kernel/commands/occurrence.ts`<br>`packages/work/src/kernel/commands/schedule.ts`<br>`packages/work/src/kernel/commands/every.ts`<br>`packages/work/src/kernel/commands/arguments.ts` |
| `packages/work/src/kernel/tables.ts` | split-with-existing-entry: `packages/work/src/kernel/tables.ts`<br>`packages/work/src/kernel/tables/dispatch.ts`<br>`packages/work/src/kernel/tables/occurrence.ts`<br>`packages/work/src/kernel/tables/schedule.ts`<br>`packages/work/src/kernel/tables/every.ts`<br>`packages/work/src/kernel/tables/supersession.ts`<br>`packages/work/src/kernel/tables/row.ts` |
| `packages/work/src/observation/ports.ts` | split-with-existing-entry: `packages/work/src/observation/ports.ts`<br>`packages/work/src/observation/testing.ts` |
| `packages/work/src/ports.ts` | split-with-existing-entry: `packages/work/src/ports.ts`<br>`packages/work/src/testing.ts` |
| `tools/can_parser.py`, `tools/test_can_parser.py` | Retain in this tree; proposed retirement only after Rust syntax/location fixtures and all CLI/docs/CI callers migrate. |
| `tests/e2e/fixtures/handbuilt/teamtasks-worker.mjs`, `tests/e2e/fixtures/handbuilt/teamtasks.ts` | Retain explicitly labeled handbuilt diagnosis; proposed retirement when real emitted artifact journeys cover these outcomes. |
| `draft` | Retain parent gitlink; all 148 listed contents remain independently owned at the pinned revision. |

```text
.
├── .github/
│   └── workflows/
│       ├── b1-join.yml
│       ├── e2e.yml
│       ├── integration.yml
│       ├── lane-01.yml
│       ├── lane-02.yml
│       ├── lane-03.yml
│       ├── lane-04.yml
│       ├── lane-05.yml
│       ├── lane-06.yml
│       └── release.yml
├── compiler/
│   ├── src/
│   │   ├── analysis/
│   │   │   ├── effects/
│   │   │   │   ├── declarations.rs  # + proposed; from compiler/src/analysis/effects.rs
│   │   │   │   ├── descriptions.rs  # + proposed; from compiler/src/analysis/effects.rs
│   │   │   │   ├── handlers.rs  # + proposed; from compiler/src/analysis/effects.rs
│   │   │   │   ├── migrations.rs  # + proposed; from compiler/src/analysis/effects.rs
│   │   │   │   ├── mod.rs  # + proposed; from compiler/src/analysis/effects.rs
│   │   │   │   ├── rules.rs  # + proposed; from compiler/src/analysis/effects.rs
│   │   │   │   ├── statements.rs  # + proposed; from compiler/src/analysis/effects.rs
│   │   │   │   └── tables.rs  # + proposed; from compiler/src/analysis/effects.rs
│   │   │   ├── examples/
│   │   │   │   ├── fixtures.rs  # + proposed; from compiler/src/analysis/examples.rs
│   │   │   │   ├── messages.rs  # + proposed; from compiler/src/analysis/examples.rs
│   │   │   │   ├── mod.rs  # + proposed; from compiler/src/analysis/examples.rs
│   │   │   │   ├── selectors.rs  # + proposed; from compiler/src/analysis/examples.rs
│   │   │   │   ├── sequences.rs  # + proposed; from compiler/src/analysis/examples.rs
│   │   │   │   └── tables.rs  # + proposed; from compiler/src/analysis/examples.rs
│   │   │   ├── resolve/
│   │   │   │   ├── bodies.rs  # + proposed; from compiler/src/analysis/resolve.rs
│   │   │   │   ├── cycles.rs  # + proposed; from compiler/src/analysis/resolve.rs
│   │   │   │   ├── declarations.rs  # + proposed; from compiler/src/analysis/resolve.rs
│   │   │   │   ├── expressions.rs  # + proposed; from compiler/src/analysis/resolve.rs
│   │   │   │   ├── imports.rs  # + proposed; from compiler/src/analysis/resolve.rs
│   │   │   │   ├── mod.rs  # + proposed; from compiler/src/analysis/resolve.rs
│   │   │   │   ├── modules.rs  # + proposed; from compiler/src/analysis/resolve.rs
│   │   │   │   ├── scopes.rs  # + proposed; from compiler/src/analysis/resolve.rs
│   │   │   │   ├── tables.rs  # + proposed; from compiler/src/analysis/resolve.rs
│   │   │   │   └── types.rs  # + proposed; from compiler/src/analysis/resolve.rs
│   │   │   ├── types/
│   │   │   │   ├── calls.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── constructs.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── context.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── declarations.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── effect_calls.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── expressions.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── fixtures.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── literals.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── members.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── mod.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── model.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── mutations.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── narrowing.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── operators.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── overloads.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── queries.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── rules.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── scenarios.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── schemas.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   ├── statements.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   │   └── ui.rs  # + proposed; from compiler/src/analysis/types.rs
│   │   │   ├── catalog.rs
│   │   │   ├── check.rs
│   │   │   └── mod.rs
│   │   ├── codegen/
│   │   │   ├── ir/
│   │   │   │   ├── build.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   ├── decode_effects.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   ├── decode_examples.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   ├── decode_expr.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   ├── decode_fixtures.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   ├── decode_items.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   ├── decode_pages.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   ├── decode_rules.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   ├── decode_ui.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   ├── literals.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   ├── mod.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   │   └── model.rs  # + proposed; from compiler/src/codegen/ir.rs
│   │   │   ├── js/
│   │   │   │   ├── definition.rs  # + proposed; from compiler/src/codegen/js.rs
│   │   │   │   ├── effects.rs  # + proposed; from compiler/src/codegen/js.rs
│   │   │   │   ├── expressions.rs  # + proposed; from compiler/src/codegen/js.rs
│   │   │   │   ├── mod.rs  # + proposed; from compiler/src/codegen/js.rs
│   │   │   │   ├── packages.rs  # + proposed; from compiler/src/codegen/js.rs
│   │   │   │   ├── pages.rs  # + proposed; from compiler/src/codegen/js.rs
│   │   │   │   ├── registry.rs  # + proposed; from compiler/src/codegen/js.rs
│   │   │   │   ├── scalars.rs  # + proposed; from compiler/src/codegen/js.rs
│   │   │   │   ├── schema.rs  # + proposed; from compiler/src/codegen/js.rs
│   │   │   │   └── writer.rs  # + proposed; from compiler/src/codegen/js.rs
│   │   │   ├── artifact.rs
│   │   │   ├── bdd.rs
│   │   │   ├── mod.rs
│   │   │   └── sourcemap.rs
│   │   ├── ide/
│   │   │   ├── fixes.rs
│   │   │   ├── mod.rs
│   │   │   ├── queries.rs
│   │   │   └── tokens.rs
│   │   ├── lint/
│   │   │   ├── driver.rs
│   │   │   ├── mod.rs
│   │   │   └── rules.rs
│   │   ├── lsp/
│   │   │   ├── server/
│   │   │   │   ├── backend.rs  # + proposed; from compiler/src/lsp/server.rs
│   │   │   │   ├── mod.rs  # + proposed; from compiler/src/lsp/server.rs
│   │   │   │   ├── protocol.rs  # + proposed; from compiler/src/lsp/server.rs
│   │   │   │   ├── session.rs  # + proposed; from compiler/src/lsp/server.rs
│   │   │   │   └── tests.rs  # + proposed; from compiler/src/lsp/server.rs
│   │   │   ├── mod.rs
│   │   │   └── transport.rs
│   │   ├── syntax/
│   │   │   ├── parser/
│   │   │   │   ├── attributes.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── builder.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── cursor.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── examples.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── expressions.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── given.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── migrations.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── mod.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── modules.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── recovery.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── types.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   ├── ui.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   │   └── when.rs  # + proposed; from compiler/src/syntax/parser.rs
│   │   │   ├── cst.rs
│   │   │   ├── inspect.rs  # + proposed; from compiler/src/analysis/mod.rs, compiler/src/ide/queries.rs, compiler/src/lint/rules.rs
│   │   │   ├── layout.rs
│   │   │   ├── lexer.rs
│   │   │   └── mod.rs
│   │   ├── cli.rs
│   │   ├── diagnostic.rs
│   │   ├── explain.rs
│   │   ├── format.rs
│   │   ├── json.rs
│   │   ├── lib.rs
│   │   ├── main.rs
│   │   └── source.rs
│   ├── tests/
│   │   ├── analysis/
│   │   │   ├── catalog.rs  # + proposed; from compiler/tests/analysis.rs
│   │   │   ├── corpus.rs  # + proposed; from compiler/tests/analysis.rs
│   │   │   ├── resolve.rs  # + proposed; from compiler/tests/analysis.rs
│   │   │   ├── support.rs  # + proposed; from compiler/tests/analysis.rs
│   │   │   └── types.rs  # + proposed; from compiler/tests/analysis.rs
│   │   ├── codegen/
│   │   │   ├── capabilities.rs  # + proposed; from compiler/tests/codegen.rs
│   │   │   ├── examples.rs  # + proposed; from compiler/tests/codegen.rs
│   │   │   ├── goldens.rs  # + proposed; from compiler/tests/codegen.rs
│   │   │   ├── items.rs  # + proposed; from compiler/tests/codegen.rs
│   │   │   ├── pages.rs  # + proposed; from compiler/tests/codegen.rs
│   │   │   ├── scalars.rs  # + proposed; from compiler/tests/codegen.rs
│   │   │   ├── sourcemap.rs  # + proposed; from compiler/tests/codegen.rs
│   │   │   └── support.rs  # + proposed; from compiler/tests/codegen.rs
│   │   ├── syntax/
│   │   │   ├── corpus.rs  # + proposed; from compiler/tests/syntax.rs
│   │   │   ├── layout.rs  # + proposed; from compiler/tests/syntax.rs
│   │   │   ├── lexer.rs  # + proposed; from compiler/tests/syntax.rs
│   │   │   └── parser.rs  # + proposed; from compiler/tests/syntax.rs
│   │   ├── analysis.rs
│   │   ├── authoring.rs
│   │   ├── b1_join.rs
│   │   ├── check.rs
│   │   ├── codegen.rs
│   │   ├── effects.rs
│   │   ├── format.rs
│   │   ├── foundation.rs
│   │   ├── ide.rs
│   │   ├── lint.rs
│   │   └── syntax.rs
│   ├── .gitignore
│   ├── Cargo.lock
│   ├── Cargo.toml
│   └── README.md
├── design/
│   ├── canonical-exposure-20261004/
│   │   ├── witness.can
│   │   └── witness.mjs
│   ├── complex-apps/
│   │   ├── chat-media.md
│   │   ├── completion-verification.json
│   │   ├── decide.md
│   │   ├── discover.md
│   │   ├── enrich.md
│   │   ├── inbox.md
│   │   ├── knowledge.md
│   │   ├── nine-app-verification.json
│   │   ├── sync.md
│   │   └── workbench.md
│   ├── evaluation/
│   │   ├── baseline-20261004T041647Z/
│   │   │   ├── snapshot/
│   │   │   │   ├── draft/
│   │   │   │   │   ├── shared/
│   │   │   │   │   │   ├── Employees.can  # [H]
│   │   │   │   │   │   ├── Locations.can  # [H]
│   │   │   │   │   │   └── Suppliers.can  # [H]
│   │   │   │   │   ├── ADMIN_SURFACES.md  # [H]
│   │   │   │   │   ├── CanAffiliate.can  # [H]
│   │   │   │   │   ├── CanAffiliate.md  # [H]
│   │   │   │   │   ├── CanApprove.can  # [H]
│   │   │   │   │   ├── CanApprove.md  # [H]
│   │   │   │   │   ├── CanApprove.mjs  # [H]
│   │   │   │   │   ├── CanBoard.can  # [H]
│   │   │   │   │   ├── CanBoard.md  # [H]
│   │   │   │   │   ├── CanBoard.mjs  # [H]
│   │   │   │   │   ├── CanBook.can  # [H]
│   │   │   │   │   ├── CanBook.md  # [H]
│   │   │   │   │   ├── CanCRM.can  # [H]
│   │   │   │   │   ├── CanCRM.md  # [H]
│   │   │   │   │   ├── CanCRM.mjs  # [H]
│   │   │   │   │   ├── CanCatch.can  # [H]
│   │   │   │   │   ├── CanCatch.md  # [H]
│   │   │   │   │   ├── CanCheck.can  # [H]
│   │   │   │   │   ├── CanCheck.md  # [H]
│   │   │   │   │   ├── CanCheck.mjs  # [H]
│   │   │   │   │   ├── CanContract.can  # [H]
│   │   │   │   │   ├── CanContract.md  # [H]
│   │   │   │   │   ├── CanCustomer.can  # [H]
│   │   │   │   │   ├── CanCustomer.md  # [H]
│   │   │   │   │   ├── CanDesk.can  # [H]
│   │   │   │   │   ├── CanDesk.md  # [H]
│   │   │   │   │   ├── CanDo.can  # [H]
│   │   │   │   │   ├── CanDo.md  # [H]
│   │   │   │   │   ├── CanEvent.can  # [H]
│   │   │   │   │   ├── CanEvent.md  # [H]
│   │   │   │   │   ├── CanExpense.can  # [H]
│   │   │   │   │   ├── CanExpense.md  # [H]
│   │   │   │   │   ├── CanExpense.mjs  # [H]
│   │   │   │   │   ├── CanFeedback.can  # [H]
│   │   │   │   │   ├── CanFeedback.md  # [H]
│   │   │   │   │   ├── CanFeedback.mjs  # [H]
│   │   │   │   │   ├── CanField.can  # [H]
│   │   │   │   │   ├── CanField.md  # [H]
│   │   │   │   │   ├── CanGrant.can  # [H]
│   │   │   │   │   ├── CanGrant.md  # [H]
│   │   │   │   │   ├── CanGrant.mjs  # [H]
│   │   │   │   │   ├── CanHire.can  # [H]
│   │   │   │   │   ├── CanHire.md  # [H]
│   │   │   │   │   ├── CanHire.mjs  # [H]
│   │   │   │   │   ├── CanInvoice.can  # [H]
│   │   │   │   │   ├── CanInvoice.md  # [H]
│   │   │   │   │   ├── CanLearn.can  # [H]
│   │   │   │   │   ├── CanLearn.md  # [H]
│   │   │   │   │   ├── CanLeave.can  # [H]
│   │   │   │   │   ├── CanLeave.md  # [H]
│   │   │   │   │   ├── CanLeave.mjs  # [H]
│   │   │   │   │   ├── CanLoyalty.can  # [H]
│   │   │   │   │   ├── CanLoyalty.md  # [H]
│   │   │   │   │   ├── CanLoyalty.mjs  # [H]
│   │   │   │   │   ├── CanMail.can  # [H]
│   │   │   │   │   ├── CanMail.md  # [H]
│   │   │   │   │   ├── CanMail.mjs  # [H]
│   │   │   │   │   ├── CanMaintain.can  # [H]
│   │   │   │   │   ├── CanMaintain.md  # [H]
│   │   │   │   │   ├── CanMaintain.mjs  # [H]
│   │   │   │   │   ├── CanMember.can  # [H]
│   │   │   │   │   ├── CanMember.md  # [H]
│   │   │   │   │   ├── CanOnboard.can  # [H]
│   │   │   │   │   ├── CanOnboard.md  # [H]
│   │   │   │   │   ├── CanOnboard.mjs  # [H]
│   │   │   │   │   ├── CanPropose.can  # [H]
│   │   │   │   │   ├── CanPropose.md  # [H]
│   │   │   │   │   ├── CanPurchase.can  # [H]
│   │   │   │   │   ├── CanPurchase.md  # [H]
│   │   │   │   │   ├── CanPurchase.mjs  # [H]
│   │   │   │   │   ├── CanReception.can  # [H]
│   │   │   │   │   ├── CanReception.md  # [H]
│   │   │   │   │   ├── CanRefer.can  # [H]
│   │   │   │   │   ├── CanRefer.md  # [H]
│   │   │   │   │   ├── CanRefer.mjs  # [H]
│   │   │   │   │   ├── CanRent.can  # [H]
│   │   │   │   │   ├── CanRent.md  # [H]
│   │   │   │   │   ├── CanRent.mjs  # [H]
│   │   │   │   │   ├── CanReport.can  # [H]
│   │   │   │   │   ├── CanReport.md  # [H]
│   │   │   │   │   ├── CanShift.can  # [H]
│   │   │   │   │   ├── CanShift.md  # [H]
│   │   │   │   │   ├── CanShift.mjs  # [H]
│   │   │   │   │   ├── CanStats.can  # [H]
│   │   │   │   │   ├── CanStats.md  # [H]
│   │   │   │   │   ├── CanStock.can  # [H]
│   │   │   │   │   ├── CanStock.md  # [H]
│   │   │   │   │   ├── CanStock.mjs  # [H]
│   │   │   │   │   ├── CanSuccess.can  # [H]
│   │   │   │   │   ├── CanSuccess.md  # [H]
│   │   │   │   │   ├── CanTable.can  # [H]
│   │   │   │   │   ├── CanTable.md  # [H]
│   │   │   │   │   ├── CanTable.mjs  # [H]
│   │   │   │   │   ├── CanTime.can  # [H]
│   │   │   │   │   ├── CanTime.md  # [H]
│   │   │   │   │   ├── CanTime.mjs  # [H]
│   │   │   │   │   ├── CanTrade.can  # [H]
│   │   │   │   │   ├── CanTrade.md  # [H]
│   │   │   │   │   ├── CanVolunteer.can  # [H]
│   │   │   │   │   ├── CanVolunteer.md  # [H]
│   │   │   │   │   ├── CanVolunteer.mjs  # [H]
│   │   │   │   │   ├── MIGRATION.md  # [H]
│   │   │   │   │   ├── PORTFOLIO.md  # [H]
│   │   │   │   │   ├── README.md  # [H]
│   │   │   │   │   └── WORKSPACE_OPERATOR.md  # [H]
│   │   │   │   ├── examples/
│   │   │   │   │   ├── ExpenseFlow.can  # [H]
│   │   │   │   │   └── TeamTasks.can  # [H]
│   │   │   │   ├── AGENTS.md  # [H]
│   │   │   │   ├── DECISIONS.md  # [H]
│   │   │   │   ├── DESIGN.md  # [H]
│   │   │   │   ├── EVALUATION.md  # [H]
│   │   │   │   ├── GRAMMAR.md  # [H]
│   │   │   │   └── REQUIREMENTS.md  # [H]
│   │   │   ├── README.md
│   │   │   └── SHA256SUMS
│   │   ├── briefs/
│   │   │   ├── ADOPTION.md
│   │   │   ├── INTERFACES.md
│   │   │   └── LANGUAGE.md
│   │   ├── evidence/
│   │   │   ├── adoption/
│   │   │   │   ├── economics/
│   │   │   │   │   ├── assumptions.md
│   │   │   │   │   ├── model.py
│   │   │   │   │   └── results.json  # [G]
│   │   │   │   ├── experiments/
│   │   │   │   │   ├── C/
│   │   │   │   │   │   ├── change-1/
│   │   │   │   │   │   │   ├── app.can
│   │   │   │   │   │   │   ├── notes.md
│   │   │   │   │   │   │   └── source.diff
│   │   │   │   │   │   ├── change-2/
│   │   │   │   │   │   │   ├── app.can
│   │   │   │   │   │   │   ├── notes.md
│   │   │   │   │   │   │   ├── source.diff
│   │   │   │   │   │   │   └── transition.md
│   │   │   │   │   │   ├── change-3/
│   │   │   │   │   │   │   ├── app.can
│   │   │   │   │   │   │   ├── notes.md
│   │   │   │   │   │   │   └── source.diff
│   │   │   │   │   │   ├── assumptions.md
│   │   │   │   │   │   ├── changes-context.md
│   │   │   │   │   │   ├── changes-metadata.json
│   │   │   │   │   │   ├── changes-notes.md
│   │   │   │   │   │   ├── context.md
│   │   │   │   │   │   ├── initial.can
│   │   │   │   │   │   ├── metadata.json
│   │   │   │   │   │   ├── review-changes.md
│   │   │   │   │   │   └── supplied-docs.json
│   │   │   │   │   ├── D/
│   │   │   │   │   │   ├── change-1/
│   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   ├── templates/
│   │   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   │   ├── base.html
│   │   │   │   │   │   │   │   │   │   ├── error.html
│   │   │   │   │   │   │   │   │   │   ├── form.html
│   │   │   │   │   │   │   │   │   │   ├── intake.html
│   │   │   │   │   │   │   │   │   │   ├── list.html
│   │   │   │   │   │   │   │   │   │   ├── token.html
│   │   │   │   │   │   │   │   │   │   └── upload.html
│   │   │   │   │   │   │   │   │   └── registration/
│   │   │   │   │   │   │   │   │       └── login.html
│   │   │   │   │   │   │   │   ├── __init__.py
│   │   │   │   │   │   │   │   ├── chat_auth.py
│   │   │   │   │   │   │   │   ├── forms.py
│   │   │   │   │   │   │   │   ├── mcp_server.py
│   │   │   │   │   │   │   │   ├── models.py
│   │   │   │   │   │   │   │   ├── service.py
│   │   │   │   │   │   │   │   ├── tests.py
│   │   │   │   │   │   │   │   ├── urls.py
│   │   │   │   │   │   │   │   └── views.py
│   │   │   │   │   │   │   ├── behavior.md
│   │   │   │   │   │   │   ├── requirements.txt
│   │   │   │   │   │   │   ├── test_settings.py
│   │   │   │   │   │   │   ├── transition.md
│   │   │   │   │   │   │   └── wiring.md
│   │   │   │   │   │   ├── change-2/
│   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   ├── templates/
│   │   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   │   ├── base.html
│   │   │   │   │   │   │   │   │   │   ├── error.html
│   │   │   │   │   │   │   │   │   │   ├── form.html
│   │   │   │   │   │   │   │   │   │   ├── intake.html
│   │   │   │   │   │   │   │   │   │   ├── list.html
│   │   │   │   │   │   │   │   │   │   ├── token.html
│   │   │   │   │   │   │   │   │   │   └── upload.html
│   │   │   │   │   │   │   │   │   └── registration/
│   │   │   │   │   │   │   │   │       └── login.html
│   │   │   │   │   │   │   │   ├── __init__.py
│   │   │   │   │   │   │   │   ├── chat_auth.py
│   │   │   │   │   │   │   │   ├── forms.py
│   │   │   │   │   │   │   │   ├── mcp_server.py
│   │   │   │   │   │   │   │   ├── models.py
│   │   │   │   │   │   │   │   ├── service.py
│   │   │   │   │   │   │   │   ├── tests.py
│   │   │   │   │   │   │   │   ├── urls.py
│   │   │   │   │   │   │   │   └── views.py
│   │   │   │   │   │   │   ├── behavior.md
│   │   │   │   │   │   │   ├── requirements.txt
│   │   │   │   │   │   │   ├── test_settings.py
│   │   │   │   │   │   │   ├── transition.md
│   │   │   │   │   │   │   ├── transition_operations.py
│   │   │   │   │   │   │   └── wiring.md
│   │   │   │   │   │   ├── change-3/
│   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   ├── templates/
│   │   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   │   ├── base.html
│   │   │   │   │   │   │   │   │   │   ├── detail.html
│   │   │   │   │   │   │   │   │   │   ├── error.html
│   │   │   │   │   │   │   │   │   │   ├── form.html
│   │   │   │   │   │   │   │   │   │   ├── intake.html
│   │   │   │   │   │   │   │   │   │   ├── list.html
│   │   │   │   │   │   │   │   │   │   ├── reviews.html
│   │   │   │   │   │   │   │   │   │   ├── token.html
│   │   │   │   │   │   │   │   │   │   └── upload.html
│   │   │   │   │   │   │   │   │   └── registration/
│   │   │   │   │   │   │   │   │       └── login.html
│   │   │   │   │   │   │   │   ├── __init__.py
│   │   │   │   │   │   │   │   ├── chat_auth.py
│   │   │   │   │   │   │   │   ├── forms.py
│   │   │   │   │   │   │   │   ├── mcp_server.py
│   │   │   │   │   │   │   │   ├── models.py
│   │   │   │   │   │   │   │   ├── service.py
│   │   │   │   │   │   │   │   ├── tests.py
│   │   │   │   │   │   │   │   ├── urls.py
│   │   │   │   │   │   │   │   └── views.py
│   │   │   │   │   │   │   ├── behavior.md
│   │   │   │   │   │   │   ├── permission-transition.md
│   │   │   │   │   │   │   ├── requirements.txt
│   │   │   │   │   │   │   ├── test_settings.py
│   │   │   │   │   │   │   ├── transition.md
│   │   │   │   │   │   │   ├── transition_operations.py
│   │   │   │   │   │   │   └── wiring.md
│   │   │   │   │   │   ├── initial/
│   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   ├── templates/
│   │   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   │   ├── base.html
│   │   │   │   │   │   │   │   │   │   ├── error.html
│   │   │   │   │   │   │   │   │   │   ├── form.html
│   │   │   │   │   │   │   │   │   │   ├── intake.html
│   │   │   │   │   │   │   │   │   │   ├── list.html
│   │   │   │   │   │   │   │   │   │   ├── token.html
│   │   │   │   │   │   │   │   │   │   └── upload.html
│   │   │   │   │   │   │   │   │   └── registration/
│   │   │   │   │   │   │   │   │       └── login.html
│   │   │   │   │   │   │   │   ├── __init__.py
│   │   │   │   │   │   │   │   ├── chat_auth.py
│   │   │   │   │   │   │   │   ├── forms.py
│   │   │   │   │   │   │   │   ├── mcp_server.py
│   │   │   │   │   │   │   │   ├── models.py
│   │   │   │   │   │   │   │   ├── service.py
│   │   │   │   │   │   │   │   ├── tests.py
│   │   │   │   │   │   │   │   ├── urls.py
│   │   │   │   │   │   │   │   └── views.py
│   │   │   │   │   │   │   ├── behavior.md
│   │   │   │   │   │   │   ├── checks.json
│   │   │   │   │   │   │   ├── requirements.txt
│   │   │   │   │   │   │   ├── test_settings.py
│   │   │   │   │   │   │   └── wiring.md
│   │   │   │   │   │   ├── assumptions.md
│   │   │   │   │   │   ├── changes-checks.json
│   │   │   │   │   │   ├── changes-context.md
│   │   │   │   │   │   ├── changes-metadata.json
│   │   │   │   │   │   ├── changes-notes.md
│   │   │   │   │   │   ├── context.md
│   │   │   │   │   │   ├── metadata.json
│   │   │   │   │   │   ├── review-changes.md
│   │   │   │   │   │   ├── review-initial.md
│   │   │   │   │   │   └── supplied-docs.json
│   │   │   │   │   ├── layout/
│   │   │   │   │   │   ├── packages/
│   │   │   │   │   │   │   ├── after/
│   │   │   │   │   │   │   │   ├── CanExpense.can
│   │   │   │   │   │   │   │   ├── Employees.can
│   │   │   │   │   │   │   │   └── Locations.can
│   │   │   │   │   │   │   ├── before/
│   │   │   │   │   │   │   │   ├── CanExpense.can
│   │   │   │   │   │   │   │   ├── Employees.can
│   │   │   │   │   │   │   │   └── Locations.can
│   │   │   │   │   │   │   ├── context.md
│   │   │   │   │   │   │   ├── metadata.json
│   │   │   │   │   │   │   └── notes.md
│   │   │   │   │   │   ├── single/
│   │   │   │   │   │   │   ├── after/
│   │   │   │   │   │   │   │   └── ExpenseWorkspace.can
│   │   │   │   │   │   │   ├── before/
│   │   │   │   │   │   │   │   └── ExpenseWorkspace.can
│   │   │   │   │   │   │   ├── context.md
│   │   │   │   │   │   │   ├── metadata.json
│   │   │   │   │   │   │   └── notes.md
│   │   │   │   │   │   ├── brief.md
│   │   │   │   │   │   └── layout-inputs.json
│   │   │   │   │   ├── provider/
│   │   │   │   │   │   ├── CanMail.can
│   │   │   │   │   │   └── replacement.md
│   │   │   │   │   ├── assessment.md
│   │   │   │   │   ├── changes-brief.md
│   │   │   │   │   └── layout-assessment.md
│   │   │   │   ├── jev/
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── egress-check.md
│   │   │   │   │   ├── mock-1.request.json
│   │   │   │   │   ├── mock-1.result.json
│   │   │   │   │   ├── mock-2.request.json
│   │   │   │   │   ├── mock-2.result.json
│   │   │   │   │   ├── mock-3.request.json
│   │   │   │   │   ├── mock-3.result.json
│   │   │   │   │   ├── prepare_requests.py
│   │   │   │   │   └── wording.md
│   │   │   │   ├── measurements/
│   │   │   │   │   ├── METHOD.md
│   │   │   │   │   ├── corpus.json
│   │   │   │   │   ├── environment.txt
│   │   │   │   │   ├── experiments.json
│   │   │   │   │   ├── measure.py
│   │   │   │   │   ├── measure_experiments.py
│   │   │   │   │   └── repetition.json
│   │   │   │   ├── consolidation.md
│   │   │   │   ├── experiment-protocol.md
│   │   │   │   ├── journeys.md
│   │   │   │   ├── methods.md
│   │   │   │   └── ownership.md
│   │   │   ├── interfaces/
│   │   │   │   ├── jev/
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── request-1.json
│   │   │   │   │   ├── request-2.json
│   │   │   │   │   ├── request-3.json
│   │   │   │   │   ├── requests.py
│   │   │   │   │   ├── response-1.json
│   │   │   │   │   ├── response-2.json
│   │   │   │   │   └── response-3.json
│   │   │   │   ├── C-initial-review.md
│   │   │   │   ├── CanCRM-inline-caption.can
│   │   │   │   ├── TeamTasks-de-message-edit.can
│   │   │   │   ├── TeamTasks-de.can
│   │   │   │   ├── corpus-scan.json
│   │   │   │   ├── external-interface-facts.md
│   │   │   │   ├── inline-caption-experiment.py
│   │   │   │   ├── inline-caption-measurements.json
│   │   │   │   ├── locale-experiment.py
│   │   │   │   ├── locale-measurements.json
│   │   │   │   ├── message-scan.json
│   │   │   │   ├── provider-facts.md
│   │   │   │   └── target-correspondence.md
│   │   │   └── language/
│   │   │       ├── jev/
│   │   │       │   ├── e102-a.questions.json
│   │   │       │   ├── e102-a.result.json
│   │   │       │   ├── e102-b.questions.json
│   │   │       │   ├── e102-b.result.json
│   │   │       │   ├── e102-c.questions.json
│   │   │       │   ├── e102-c.result.json
│   │   │       │   └── wording.md
│   │   │       ├── alternatives.md
│   │   │       ├── corpus.json
│   │   │       ├── experiment-c-review.md
│   │   │       ├── experiment-final-review.md
│   │   │       ├── findings.md
│   │   │       ├── rules.md
│   │   │       ├── traces.md
│   │   │       └── verification.json
│   │   ├── ADOPTION.md
│   │   ├── INTERFACES.md
│   │   ├── LANGUAGE.md
│   │   └── verification.json
│   ├── historical-intake-20261004/
│   │   ├── application-checks.json
│   │   ├── witness.can
│   │   └── witness.mjs
│   ├── jev/
│   │   ├── 2026-10-04-purchase-stock/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── README.md
│   │   │   └── wording-check.txt
│   │   ├── business-ai-boundary-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   └── review.md
│   │   ├── cafe-completion-20261004/
│   │   │   ├── analysis.md
│   │   │   ├── equivalence.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── result-1.json  # [G]
│   │   │   ├── result-2.json  # [G]
│   │   │   └── result-3.json  # [G]
│   │   ├── canonical-exposure-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   └── 3.result.json  # [G]
│   │   ├── catch-intake-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── assessment.md
│   │   │   └── wording-check.md
│   │   ├── check-completion-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── decision.md
│   │   │   └── wording-check.md
│   │   ├── complex-chat-media-20261004/
│   │   │   ├── syntax-projections/
│   │   │   │   ├── CanChat.can
│   │   │   │   ├── CanChat.changes.txt
│   │   │   │   ├── CanCreative.can
│   │   │   │   ├── CanCreative.changes.txt
│   │   │   │   ├── CanGallery.can
│   │   │   │   └── CanGallery.changes.txt
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── 4.request.json
│   │   │   ├── 4.result.json  # [G]
│   │   │   ├── 5.request.json
│   │   │   ├── 5.result.json  # [G]
│   │   │   ├── 6.request.json
│   │   │   ├── 6.result.json  # [G]
│   │   │   ├── assessment.md
│   │   │   ├── check-descriptors.cjs
│   │   │   └── descriptor-check.json
│   │   ├── complex-decide-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── assessment.md
│   │   │   ├── check-descriptors.cjs
│   │   │   ├── syntax-projection-changes.txt
│   │   │   └── syntax-projection.can
│   │   ├── complex-discover-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   └── 3.result.json  # [G]
│   │   ├── complex-enrich-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── assessment.md
│   │   │   ├── final-verification.json
│   │   │   └── wording.md
│   │   ├── complex-inbox-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── authoring-comparison.md
│   │   │   ├── check-draft.py
│   │   │   ├── static-verification.json
│   │   │   └── verification.md
│   │   ├── complex-knowledge-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── check-draft.py
│   │   │   ├── final-descriptor-review.cjs
│   │   │   ├── static-verification.json
│   │   │   └── verification.md
│   │   ├── complex-sync-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── assessment.md
│   │   │   └── wording.md
│   │   ├── complex-workbench-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── final-descriptor-review.cjs
│   │   │   └── final-verification.json
│   │   ├── crm-connections-reschedule-20261004/
│   │   │   ├── README.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   ├── verification.md
│   │   │   └── wording-check.txt
│   │   ├── daisyui-catalog-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── assessment.md
│   │   │   └── wording-check.md
│   │   ├── delivery-association-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   └── 3.result.json  # [G]
│   │   ├── delivery-leaf-grants-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   └── 3.result.json  # [G]
│   │   ├── delivery-recipe-overrides-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── verification.md
│   │   │   ├── witness.can
│   │   │   ├── witness.mjs
│   │   │   └── wording-check.md
│   │   ├── desk-handoff-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── review.md
│   │   │   └── wording-check.md
│   │   ├── event-completion-20261004/
│   │   │   ├── investigation.txt
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   └── wording-check.txt
│   │   ├── feedback-completion-20261004/
│   │   │   ├── analysis.md
│   │   │   ├── equivalence.md
│   │   │   ├── final-request-1.json
│   │   │   ├── final-request-2.json
│   │   │   ├── final-request-3.json
│   │   │   ├── final-result-1.json  # [G]
│   │   │   ├── final-result-2.json  # [G]
│   │   │   ├── final-result-3.json  # [G]
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   └── result-1.json  # [G]
│   │   ├── fixture-actors-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   └── assessment.md
│   │   ├── fixture-journeys-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   └── assessment.md
│   │   ├── grant-completion/
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── review-1.json  # [G]
│   │   │   ├── review-2.json  # [G]
│   │   │   └── review-3.json  # [G]
│   │   ├── grant-review-recovery/
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── review-1.json  # [G]
│   │   │   ├── review-2.json  # [G]
│   │   │   └── review-3.json  # [G]
│   │   ├── hire-onboard-20261004/
│   │   │   ├── assessment.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   └── wording-check.md
│   │   ├── hire-retention-20261004/
│   │   │   ├── assessment.md
│   │   │   ├── corrected-request-1.json
│   │   │   ├── corrected-request-2.json
│   │   │   ├── corrected-request-3.json
│   │   │   ├── corrected-response-1.json  # [G]
│   │   │   ├── corrected-response-2.json  # [G]
│   │   │   ├── corrected-response-3.json  # [G]
│   │   │   ├── corrected-wording-check.md
│   │   │   ├── correction.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   └── wording-check.md
│   │   ├── historical-intake-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   └── 3.result.json  # [G]
│   │   ├── leave-shift-completion-20261004/
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── result-1.json  # [G]
│   │   │   ├── result-2.json  # [G]
│   │   │   ├── result-3.json  # [G]
│   │   │   ├── review.json
│   │   │   └── wording-check.txt
│   │   ├── loyalty-eligibility-20261004/
│   │   │   ├── assessment.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   └── wording-check.md
│   │   ├── mail-completion-20261004/
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   ├── review.txt
│   │   │   └── wording-review.txt
│   │   ├── maintain-inspection-progress/
│   │   │   ├── decision.md
│   │   │   ├── generic-request-1.json
│   │   │   ├── generic-request-2.json
│   │   │   ├── generic-request-3.json
│   │   │   ├── generic-response-1.json  # [G]
│   │   │   ├── generic-response-2.json  # [G]
│   │   │   ├── generic-response-3.json  # [G]
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   ├── review-evidence.json
│   │   │   └── verification.md
│   │   ├── maintain-recovery-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── review.md
│   │   │   └── wording-check.md
│   │   ├── mcp-file-handoff-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── assessment.md
│   │   │   └── wording-check.md
│   │   ├── member-consumed-stage-20261004/
│   │   │   ├── assessment.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   └── wording-check.md
│   │   ├── member-owner-20261004/
│   │   │   ├── assessment.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   └── wording-check.md
│   │   ├── muse-dependency-20261004/
│   │   │   └── STATUS.md
│   │   ├── muse-feedback-20261004/
│   │   │   ├── assessment.md
│   │   │   ├── bounded-review.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── result-1.json  # [G]
│   │   │   ├── result-2.json  # [G]
│   │   │   ├── result-3.json  # [G]
│   │   │   └── syntax-checks.json
│   │   ├── muse-mail-recovery-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   └── 3.result.json  # [G]
│   │   ├── optional-dependency-closure-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.rejected.request.json
│   │   │   ├── 3.rejection.md
│   │   │   ├── 3.request.json
│   │   │   └── 3.result.json  # [G]
│   │   ├── owner-fanout-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.blocked.json
│   │   │   ├── 2.request.json
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   └── review.md
│   │   ├── page-discovery-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   └── assessment.md
│   │   ├── parent-field-default-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   └── review.md
│   │   ├── person-selection-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   └── 3.result.json  # [G]
│   │   ├── record-input-admission-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── assessment.md
│   │   │   └── wording-check.md
│   │   ├── rent-history-growth-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── 4.request.json
│   │   │   ├── 4.result.json  # [G]
│   │   │   ├── 5.rejection.txt
│   │   │   ├── 5.request.json
│   │   │   ├── 6.request.json
│   │   │   ├── 6.result.json  # [G]
│   │   │   └── capture-sites.json
│   │   ├── rent-sales-producer-20261004/
│   │   │   ├── assessment.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   └── wording-check.md
│   │   ├── rent-sales-version-boundary-20261004/
│   │   │   ├── assessment.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   └── wording-check.md
│   │   ├── report-completion-20261004/
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── response-1.json  # [G]
│   │   │   ├── response-2.json  # [G]
│   │   │   ├── response-3.json  # [G]
│   │   │   └── wording-check.txt
│   │   ├── stats-breakdown-20261004/
│   │   │   ├── 1.request.json
│   │   │   ├── 1.result.json  # [G]
│   │   │   ├── 2.request.json
│   │   │   ├── 2.result.json  # [G]
│   │   │   ├── 3.request.json
│   │   │   ├── 3.result.json  # [G]
│   │   │   ├── assessment.md
│   │   │   └── wording-check.md
│   │   ├── time-completion-20261004/
│   │   │   ├── analysis.md
│   │   │   ├── request-1.json
│   │   │   ├── request-2.json
│   │   │   ├── request-3.json
│   │   │   ├── result-1.json  # [G]
│   │   │   ├── result-2.json  # [G]
│   │   │   ├── result-3.json  # [G]
│   │   │   └── wording-check.md
│   │   ├── 01-foundations.questions.json
│   │   ├── 01-foundations.result.json  # [G]
│   │   ├── 02-boundaries.questions.json
│   │   ├── 02-boundaries.result.json  # [G]
│   │   ├── 03-consistency.questions.json
│   │   ├── 03-consistency.result.json  # [G]
│   │   ├── 04-inline-tests.questions.json
│   │   ├── 04-inline-tests.result.json  # [G]
│   │   ├── 05-fragments.questions.json
│   │   ├── 05-fragments.result.json  # [G]
│   │   ├── 06-migration-boundaries.questions.json
│   │   ├── 06-migration-boundaries.result.json  # [G]
│   │   ├── 07-source-ownership.questions.json
│   │   ├── 07-source-ownership.result.json  # [G]
│   │   ├── 08-app-composition-b.questions.json
│   │   ├── 08-app-composition-b.result.json  # [G]
│   │   ├── 08-app-composition-c.questions.json
│   │   ├── 08-app-composition-c.result.json  # [G]
│   │   ├── 08-app-composition.questions.json
│   │   ├── 08-app-composition.result.json  # [G]
│   │   ├── 09-repetition-b.questions.json
│   │   ├── 09-repetition-b.result.json  # [G]
│   │   ├── 09-repetition-c.questions.json
│   │   ├── 09-repetition-c.result.json  # [G]
│   │   ├── 09-repetition.questions.json
│   │   ├── 09-repetition.result.json  # [G]
│   │   ├── 10-noul-repetition-b.questions.json
│   │   ├── 10-noul-repetition-b.result.json  # [G]
│   │   ├── 10-noul-repetition-c.questions.json
│   │   ├── 10-noul-repetition-c.result.json  # [G]
│   │   ├── 10-noul-repetition.questions.json
│   │   ├── 10-noul-repetition.result.json  # [G]
│   │   ├── 11-wide-layout-b.questions.json
│   │   ├── 11-wide-layout-b.result.json  # [G]
│   │   ├── 11-wide-layout-c.questions.json
│   │   ├── 11-wide-layout-c.result.json  # [G]
│   │   ├── 11-wide-layout.questions.json
│   │   ├── 11-wide-layout.result.json  # [G]
│   │   ├── 12-wide-layout-balanced-b.questions.json
│   │   ├── 12-wide-layout-balanced-b.result.json  # [G]
│   │   ├── 12-wide-layout-balanced-c.questions.json
│   │   ├── 12-wide-layout-balanced-c.result.json  # [G]
│   │   ├── 12-wide-layout-balanced.questions.json
│   │   ├── 12-wide-layout-balanced.result.json  # [G]
│   │   ├── 13-direct-scenario-body-b.questions.json
│   │   ├── 13-direct-scenario-body-b.result.json  # [G]
│   │   ├── 13-direct-scenario-body-c.questions.json
│   │   ├── 13-direct-scenario-body-c.result.json  # [G]
│   │   ├── 13-direct-scenario-body.questions.json
│   │   ├── 13-direct-scenario-body.result.json  # [G]
│   │   ├── 14-do-body-b.questions.json
│   │   ├── 14-do-body-b.result.json  # [G]
│   │   ├── 14-do-body-c.questions.json
│   │   ├── 14-do-body-c.result.json  # [G]
│   │   ├── 14-do-body.questions.json
│   │   ├── 14-do-body.result.json  # [G]
│   │   ├── 15-syntax-borrowings-b.questions.json
│   │   ├── 15-syntax-borrowings-b.result.json  # [G]
│   │   ├── 15-syntax-borrowings-c.questions.json
│   │   ├── 15-syntax-borrowings-c.result.json  # [G]
│   │   ├── 15-syntax-borrowings.questions.json
│   │   ├── 15-syntax-borrowings.result.json  # [G]
│   │   ├── 16-required-null-grammar-b.questions.json
│   │   ├── 16-required-null-grammar-b.result.json  # [G]
│   │   ├── 16-required-null-grammar-c.questions.json
│   │   ├── 16-required-null-grammar-c.result.json  # [G]
│   │   ├── 16-required-null-grammar.questions.json
│   │   ├── 16-required-null-grammar.result.json  # [G]
│   │   ├── 17-remaining-syntax-b.questions.json
│   │   ├── 17-remaining-syntax-b.result.json  # [G]
│   │   ├── 17-remaining-syntax-c.questions.json
│   │   ├── 17-remaining-syntax-c.result.json  # [G]
│   │   ├── 17-remaining-syntax.questions.json
│   │   ├── 17-remaining-syntax.result.json  # [G]
│   │   ├── 18-team-defaults-b.questions.json
│   │   ├── 18-team-defaults-b.result.json  # [G]
│   │   ├── 18-team-defaults-c.questions.json
│   │   ├── 18-team-defaults-c.result.json  # [G]
│   │   ├── 18-team-defaults.questions.json
│   │   ├── 18-team-defaults.result.json  # [G]
│   │   ├── 19-implicit-app-identity-b.questions.json
│   │   ├── 19-implicit-app-identity-b.result.json  # [G]
│   │   ├── 19-implicit-app-identity-c.questions.json
│   │   ├── 19-implicit-app-identity-c.result.json  # [G]
│   │   ├── 19-implicit-app-identity.questions.json
│   │   ├── 19-implicit-app-identity.result.json  # [G]
│   │   ├── 20-primitive-contracts-b.questions.json
│   │   ├── 20-primitive-contracts-b.result.json  # [G]
│   │   ├── 20-primitive-contracts-c.questions.json
│   │   ├── 20-primitive-contracts-c.result.json  # [G]
│   │   ├── 20-primitive-contracts-d.questions.json
│   │   ├── 20-primitive-contracts-d.result.json  # [G]
│   │   ├── 20-primitive-contracts-e.questions.json
│   │   ├── 20-primitive-contracts-e.result.json  # [G]
│   │   ├── 20-primitive-contracts-f.questions.json
│   │   ├── 20-primitive-contracts-f.result.json  # [G]
│   │   ├── 20-primitive-contracts.questions.json
│   │   ├── 20-primitive-contracts.result.json  # [G]
│   │   ├── 21-file-fixtures-b.questions.json
│   │   ├── 21-file-fixtures-b.result.json  # [G]
│   │   ├── 21-file-fixtures-c.questions.json
│   │   ├── 21-file-fixtures-c.result.json  # [G]
│   │   ├── 21-file-fixtures.questions.json
│   │   ├── 21-file-fixtures.result.json  # [G]
│   │   ├── 22-schema-evolution-b.questions.json
│   │   ├── 22-schema-evolution-b.result.json  # [G]
│   │   ├── 22-schema-evolution-c.questions.json
│   │   ├── 22-schema-evolution-c.result.json  # [G]
│   │   ├── 22-schema-evolution.questions.json
│   │   ├── 22-schema-evolution.result.json  # [G]
│   │   ├── 23-exact-grammar-b.questions.json
│   │   ├── 23-exact-grammar-b.result.json  # [G]
│   │   ├── 23-exact-grammar-c.questions.json
│   │   ├── 23-exact-grammar-c.result.json  # [G]
│   │   ├── 23-exact-grammar.questions.json
│   │   ├── 23-exact-grammar.result.json  # [G]
│   │   ├── 24-i18n-b.questions.json
│   │   ├── 24-i18n-b.result.json  # [G]
│   │   ├── 24-i18n-c.questions.json
│   │   ├── 24-i18n-c.result.json  # [G]
│   │   ├── 24-i18n.questions.json
│   │   ├── 24-i18n.result.json  # [G]
│   │   ├── 25-draft-i18n.questions.json
│   │   ├── 26-frontend-requirements-b.questions.json
│   │   ├── 26-frontend-requirements-b.result.json  # [G]
│   │   ├── 26-frontend-requirements-c.questions.json
│   │   ├── 26-frontend-requirements-c.result.json  # [G]
│   │   ├── 26-frontend-requirements.questions.json
│   │   ├── 26-frontend-requirements.result.json  # [G]
│   │   ├── 27-frontend-source-b.questions.json
│   │   ├── 27-frontend-source-b.result.json  # [G]
│   │   ├── 27-frontend-source-c.questions.json
│   │   ├── 27-frontend-source-c.result.json  # [G]
│   │   ├── 27-frontend-source.questions.json
│   │   ├── 27-frontend-source.result.json  # [G]
│   │   ├── 28-history-default-b.questions.json
│   │   ├── 28-history-default-b.result.json  # [G]
│   │   ├── 28-history-default-c.questions.json
│   │   ├── 28-history-default-c.result.json  # [G]
│   │   ├── 28-history-default.questions.json
│   │   ├── 28-history-default.result.json  # [G]
│   │   ├── 29-inline-i18n-b.questions.json
│   │   ├── 29-inline-i18n-b.result.json  # [G]
│   │   ├── 29-inline-i18n-c.questions.json
│   │   ├── 29-inline-i18n-c.result.json  # [G]
│   │   ├── 29-inline-i18n.questions.json
│   │   ├── 29-inline-i18n.result.json  # [G]
│   │   ├── 30-inline-contract-b.questions.json
│   │   ├── 30-inline-contract-b.result.json  # [G]
│   │   ├── 30-inline-contract-c.questions.json
│   │   ├── 30-inline-contract-c.result.json  # [G]
│   │   ├── 30-inline-contract.questions.json
│   │   ├── 30-inline-contract.result.json  # [G]
│   │   ├── 31-compiler-target-b.questions.json
│   │   ├── 31-compiler-target-b.result.json  # [G]
│   │   ├── 31-compiler-target-c.questions.json
│   │   ├── 31-compiler-target-c.result.json  # [G]
│   │   ├── 31-compiler-target.questions.json
│   │   ├── 31-compiler-target.result.json  # [G]
│   │   ├── 32-toolchain-b.questions.json
│   │   ├── 32-toolchain-c.questions.json
│   │   ├── 32-toolchain.questions.json
│   │   ├── 33-server-ui-b.questions.json
│   │   ├── 33-server-ui-b.result.json  # [G]
│   │   ├── 33-server-ui-c.questions.json
│   │   ├── 33-server-ui-c.result.json  # [G]
│   │   ├── 33-server-ui.questions.json
│   │   ├── 33-server-ui.result.json  # [G]
│   │   ├── README.md
│   │   ├── draft-billing-evidence-20261004-a.questions.json
│   │   ├── draft-billing-evidence-20261004-a.result.json  # [G]
│   │   ├── draft-billing-evidence-20261004-b.questions.json
│   │   ├── draft-billing-evidence-20261004-b.result.json  # [G]
│   │   ├── draft-billing-evidence-20261004-c.questions.json
│   │   ├── draft-billing-evidence-20261004-c.result.json  # [G]
│   │   ├── draft-billing-evidence-20261004-wording.md
│   │   ├── draft-import-links-20261004-a.questions.json
│   │   ├── draft-import-links-20261004-a.result.json  # [G]
│   │   ├── draft-import-links-20261004-b.questions.json
│   │   ├── draft-import-links-20261004-b.result.json  # [G]
│   │   ├── draft-import-links-20261004-c.questions.json
│   │   ├── draft-import-links-20261004-c.result.json  # [G]
│   │   ├── draft-import-links-20261004-wording.md
│   │   ├── draft-payment-boundary-20261004-a.questions.json
│   │   ├── draft-payment-boundary-20261004-a.result.json  # [G]
│   │   ├── draft-payment-boundary-20261004-b.questions.json
│   │   ├── draft-payment-boundary-20261004-b.result.json  # [G]
│   │   ├── draft-payment-boundary-20261004-c.questions.json
│   │   ├── draft-payment-boundary-20261004-c.result.json  # [G]
│   │   ├── draft-payment-boundary-20261004-wording.md
│   │   ├── draft-query-admission-20261004-a.questions.json
│   │   ├── draft-query-admission-20261004-a.result.json  # [G]
│   │   ├── draft-query-admission-20261004-b.questions.json
│   │   ├── draft-query-admission-20261004-b.result.json  # [G]
│   │   ├── draft-query-admission-20261004-c.questions.json
│   │   ├── draft-query-admission-20261004-c.result.json  # [G]
│   │   ├── draft-query-admission-20261004-wording.md
│   │   ├── draft-role-subject-20261004-a.questions.json
│   │   ├── draft-role-subject-20261004-a.result.json  # [G]
│   │   ├── draft-role-subject-20261004-b.questions.json
│   │   ├── draft-role-subject-20261004-b.result.json  # [G]
│   │   ├── draft-role-subject-20261004-c.questions.json
│   │   ├── draft-role-subject-20261004-c.result.json  # [G]
│   │   ├── draft-role-subject-20261004-wording.md
│   │   ├── draft-static-20261004-a.questions.json
│   │   ├── draft-static-20261004-a.response.json  # [G]
│   │   ├── draft-static-20261004-b.questions.json
│   │   ├── draft-static-20261004-b.response.json  # [G]
│   │   ├── draft-static-20261004-c.questions.json
│   │   ├── draft-static-20261004-c.response.json  # [G]
│   │   ├── draft-static-20261004-self-check.json
│   │   ├── draft-ui-20261004-a.questions.json
│   │   ├── draft-ui-20261004-a.result.json  # [G]
│   │   ├── draft-ui-20261004-b.questions.json
│   │   ├── draft-ui-20261004-b.result.json  # [G]
│   │   ├── draft-ui-20261004-c.questions.json
│   │   ├── draft-ui-20261004-c.result.json  # [G]
│   │   ├── draft-ui-20261004-evidence.json
│   │   ├── draft-ui-20261004-review.json
│   │   ├── draft-ui-20261004-wording-check.json
│   │   ├── draft-work-refresh-20261004-a.questions.json
│   │   ├── draft-work-refresh-20261004-a.result.json  # [G]
│   │   ├── draft-work-refresh-20261004-b.questions.json
│   │   ├── draft-work-refresh-20261004-b.result.json  # [G]
│   │   ├── draft-work-refresh-20261004-c.questions.json
│   │   ├── draft-work-refresh-20261004-c.result.json  # [G]
│   │   ├── draft-work-refresh-20261004-wording-check.md
│   │   ├── draft-workflow-20261004-a.questions.json
│   │   ├── draft-workflow-20261004-a.result.json  # [G]
│   │   ├── draft-workflow-20261004-b.questions.json
│   │   ├── draft-workflow-20261004-b.result.json  # [G]
│   │   ├── draft-workflow-20261004-c.questions.json
│   │   ├── draft-workflow-20261004-c.result.json  # [G]
│   │   ├── draft-workflow-20261004-equivalence.md
│   │   ├── draft-workflow-20261004-review.json
│   │   ├── migration-expense-recovery-1.questions.json
│   │   ├── migration-expense-recovery-1.result.json  # [G]
│   │   ├── migration-expense-recovery-2.questions.json
│   │   ├── migration-expense-recovery-2.result.json  # [G]
│   │   ├── migration-expense-recovery-3.questions.json
│   │   ├── migration-expense-recovery-3.result.json  # [G]
│   │   ├── migration-expense-recovery.md
│   │   ├── referral-commercial-history-20261004-a.questions.json
│   │   ├── referral-commercial-history-20261004-a.result.json  # [G]
│   │   ├── referral-commercial-history-20261004-a.sandbox-failure.json
│   │   ├── referral-commercial-history-20261004-b.questions.json
│   │   ├── referral-commercial-history-20261004-b.result.json  # [G]
│   │   ├── referral-commercial-history-20261004-b.sandbox-failure.json
│   │   ├── referral-commercial-history-20261004-c.questions.json
│   │   ├── referral-commercial-history-20261004-c.result.json  # [G]
│   │   ├── referral-commercial-history-20261004-c.sandbox-failure.json
│   │   ├── rent-final-gaps-20261004-a.questions.json
│   │   ├── rent-final-gaps-20261004-a.result.json  # [G]
│   │   ├── rent-final-gaps-20261004-assessment.md
│   │   ├── rent-final-gaps-20261004-b.questions.json
│   │   ├── rent-final-gaps-20261004-b.result.json  # [G]
│   │   ├── rent-final-gaps-20261004-c.questions.json
│   │   ├── rent-final-gaps-20261004-c.result.json  # [G]
│   │   ├── rent-final-gaps-20261004-wording-check.md
│   │   ├── rent-reception-20261004-a.questions.json
│   │   ├── rent-reception-20261004-a.result.json  # [G]
│   │   ├── rent-reception-20261004-b.questions.json
│   │   ├── rent-reception-20261004-b.result.json  # [G]
│   │   ├── rent-reception-20261004-c.questions.json
│   │   ├── rent-reception-20261004-c.result.json  # [G]
│   │   ├── rent-reception-20261004-equivalence.md
│   │   ├── rent-venue-20261004-a.questions.json
│   │   ├── rent-venue-20261004-a.result.json  # [G]
│   │   ├── rent-venue-20261004-b.questions.json
│   │   ├── rent-venue-20261004-b.result.json  # [G]
│   │   ├── rent-venue-20261004-c.questions.json
│   │   ├── rent-venue-20261004-c.result.json  # [G]
│   │   ├── rent-venue-20261004-equivalence.md
│   │   ├── rent-workflows-20261004-a.questions.json
│   │   ├── rent-workflows-20261004-a.result.json  # [G]
│   │   ├── rent-workflows-20261004-b.questions.json
│   │   ├── rent-workflows-20261004-b.result.json  # [G]
│   │   ├── rent-workflows-20261004-c.questions.json
│   │   ├── rent-workflows-20261004-c.result.json  # [G]
│   │   ├── rent-workflows-20261004-equivalence.md
│   │   ├── rent-workflows-20261004-investigation.md
│   │   ├── require-naming-20261004-a.questions.json
│   │   ├── require-naming-20261004-a.result.json  # [G]
│   │   ├── require-naming-20261004-b.questions.json
│   │   ├── require-naming-20261004-b.result.json  # [G]
│   │   ├── require-naming-20261004-c.questions.json
│   │   ├── require-naming-20261004-c.result.json  # [G]
│   │   ├── require-naming-20261004-review.md
│   │   ├── require-naming-20261004-wording.md
│   │   ├── shared-attribution-capture-20261004-a.questions.json
│   │   ├── shared-attribution-capture-20261004-a.result.json  # [G]
│   │   ├── shared-attribution-capture-20261004-b.questions.json
│   │   ├── shared-attribution-capture-20261004-b.result.json  # [G]
│   │   ├── shared-attribution-capture-20261004-c.questions.json
│   │   └── shared-attribution-capture-20261004-c.result.json  # [G]
│   ├── muse-migration-20261004/
│   │   ├── dependency-design.md
│   │   ├── extraction-design.md
│   │   ├── feedback-design.md
│   │   ├── history-design.md
│   │   ├── inbox.md
│   │   ├── mail-recovery-design.md
│   │   ├── monitor.md
│   │   ├── progress-design.md
│   │   ├── review.md
│   │   └── tasks.md
│   ├── optional-dependency-closure-20261004/
│   │   ├── closure.json
│   │   ├── value-witness.can
│   │   ├── value-witness.mjs
│   │   ├── witness.can
│   │   └── witness.mjs
│   ├── rent-history-growth-20261004/
│   │   ├── checks.json
│   │   ├── current-mechanism.can.txt
│   │   ├── current-mechanism.mjs.txt
│   │   ├── current-report-handler.mjs.txt
│   │   ├── history-mechanism.can.txt
│   │   ├── history-mechanism.mjs.txt
│   │   ├── history-rows.mjs.txt
│   │   ├── input-hashes.json
│   │   ├── measurements.json
│   │   ├── negative-cases.json
│   │   ├── witness.can
│   │   └── witness.mjs
│   ├── AI-AND-SERVICE-DRAFTS.md
│   ├── COMPLEX-APPS.md
│   ├── UI-COMPONENTS.md
│   ├── canonical-exposure-20261004.md
│   ├── company-policy-review-20261004.md
│   ├── delivery-association-20261004.md
│   ├── delivery-error-20261004.md
│   ├── delivery-leaf-grants-20261004.md
│   ├── delivery-recipe-overrides-20261004.md
│   ├── field-type-reuse-20261004.md
│   ├── historical-intake-20261004.md
│   ├── optional-dependency-closure-20261004.md
│   ├── owner-fanout-20261004.md
│   ├── person-selection-20261004.md
│   ├── propose-delivery-20261004.md
│   ├── rent-history-growth-20261004.md
│   ├── research-ai-capabilities-20261004.md
│   └── research-demanding-apps-20261004.md
├── docs/
│   ├── dev-setup.md
│   ├── e2e.md
│   └── ideal-filetree-plan.md  # new documentation this task
├── draft/
│   ├── shared/
│   │   ├── Employees.can  # [D]
│   │   ├── Locations.can  # [D]
│   │   └── Suppliers.can  # [D]
│   ├── .gitignore  # [D]
│   ├── ADMIN_SURFACES.md  # [D]
│   ├── CanAffiliate.can  # [D]
│   ├── CanAffiliate.md  # [D]
│   ├── CanApprove.can  # [D]
│   ├── CanApprove.md  # [D]
│   ├── CanApprove.mjs  # [D]
│   ├── CanBoard.can  # [D]
│   ├── CanBoard.md  # [D]
│   ├── CanBoard.mjs  # [D]
│   ├── CanBook.can  # [D]
│   ├── CanBook.md  # [D]
│   ├── CanCRM.can  # [D]
│   ├── CanCRM.md  # [D]
│   ├── CanCRM.mjs  # [D]
│   ├── CanCatch.can  # [D]
│   ├── CanCatch.md  # [D]
│   ├── CanChat.can  # [D]
│   ├── CanChat.md  # [D]
│   ├── CanChat.mjs  # [D]
│   ├── CanCheck.can  # [D]
│   ├── CanCheck.md  # [D]
│   ├── CanCheck.mjs  # [D]
│   ├── CanContract.can  # [D]
│   ├── CanContract.md  # [D]
│   ├── CanCreative.can  # [D]
│   ├── CanCreative.md  # [D]
│   ├── CanCreative.mjs  # [D]
│   ├── CanCustomer.can  # [D]
│   ├── CanCustomer.md  # [D]
│   ├── CanDecide.can  # [D]
│   ├── CanDecide.md  # [D]
│   ├── CanDecide.mjs  # [D]
│   ├── CanDesk.can  # [D]
│   ├── CanDesk.md  # [D]
│   ├── CanDiscover.can  # [D]
│   ├── CanDiscover.md  # [D]
│   ├── CanDiscover.mjs  # [D]
│   ├── CanDo.can  # [D]
│   ├── CanDo.md  # [D]
│   ├── CanDo.mjs  # [D]
│   ├── CanEnrich.can  # [D]
│   ├── CanEnrich.md  # [D]
│   ├── CanEnrich.mjs  # [D]
│   ├── CanEvent.can  # [D]
│   ├── CanEvent.md  # [D]
│   ├── CanExpense.can  # [D]
│   ├── CanExpense.md  # [D]
│   ├── CanExpense.mjs  # [D]
│   ├── CanFeedback.can  # [D]
│   ├── CanFeedback.md  # [D]
│   ├── CanFeedback.mjs  # [D]
│   ├── CanField.can  # [D]
│   ├── CanField.md  # [D]
│   ├── CanGallery.can  # [D]
│   ├── CanGallery.md  # [D]
│   ├── CanGallery.mjs  # [D]
│   ├── CanGrant.can  # [D]
│   ├── CanGrant.md  # [D]
│   ├── CanGrant.mjs  # [D]
│   ├── CanHire.can  # [D]
│   ├── CanHire.md  # [D]
│   ├── CanHire.mjs  # [D]
│   ├── CanInbox.can  # [D]
│   ├── CanInbox.md  # [D]
│   ├── CanInbox.mjs  # [D]
│   ├── CanInvoice.can  # [D]
│   ├── CanInvoice.md  # [D]
│   ├── CanInvoice.mjs  # [D]
│   ├── CanKnowledge.can  # [D]
│   ├── CanKnowledge.md  # [D]
│   ├── CanKnowledge.mjs  # [D]
│   ├── CanLearn.can  # [D]
│   ├── CanLearn.md  # [D]
│   ├── CanLearn.mjs  # [D]
│   ├── CanLeave.can  # [D]
│   ├── CanLeave.md  # [D]
│   ├── CanLeave.mjs  # [D]
│   ├── CanLoyalty.can  # [D]
│   ├── CanLoyalty.md  # [D]
│   ├── CanLoyalty.mjs  # [D]
│   ├── CanMail.can  # [D]
│   ├── CanMail.md  # [D]
│   ├── CanMail.mjs  # [D]
│   ├── CanMaintain.can  # [D]
│   ├── CanMaintain.md  # [D]
│   ├── CanMaintain.mjs  # [D]
│   ├── CanMember.can  # [D]
│   ├── CanMember.md  # [D]
│   ├── CanMember.mjs  # [D]
│   ├── CanOnboard.can  # [D]
│   ├── CanOnboard.md  # [D]
│   ├── CanOnboard.mjs  # [D]
│   ├── CanPropose.can  # [D]
│   ├── CanPropose.md  # [D]
│   ├── CanPropose.mjs  # [D]
│   ├── CanPurchase.can  # [D]
│   ├── CanPurchase.md  # [D]
│   ├── CanPurchase.mjs  # [D]
│   ├── CanReception.can  # [D]
│   ├── CanReception.md  # [D]
│   ├── CanReception.mjs  # [D]
│   ├── CanRefer.can  # [D]
│   ├── CanRefer.md  # [D]
│   ├── CanRefer.mjs  # [D]
│   ├── CanRent.can  # [D]
│   ├── CanRent.md  # [D]
│   ├── CanRent.mjs  # [D]
│   ├── CanReport.can  # [D]
│   ├── CanReport.md  # [D]
│   ├── CanReport.mjs  # [D]
│   ├── CanShift.can  # [D]
│   ├── CanShift.md  # [D]
│   ├── CanShift.mjs  # [D]
│   ├── CanStats.can  # [D]
│   ├── CanStats.md  # [D]
│   ├── CanStats.mjs  # [D]
│   ├── CanStock.can  # [D]
│   ├── CanStock.md  # [D]
│   ├── CanStock.mjs  # [D]
│   ├── CanSuccess.can  # [D]
│   ├── CanSuccess.md  # [D]
│   ├── CanSuccess.mjs  # [D]
│   ├── CanSync.can  # [D]
│   ├── CanSync.md  # [D]
│   ├── CanSync.mjs  # [D]
│   ├── CanTable.can  # [D]
│   ├── CanTable.md  # [D]
│   ├── CanTable.mjs  # [D]
│   ├── CanTime.can  # [D]
│   ├── CanTime.md  # [D]
│   ├── CanTime.mjs  # [D]
│   ├── CanTrade.can  # [D]
│   ├── CanTrade.md  # [D]
│   ├── CanTrade.mjs  # [D]
│   ├── CanVolunteer.can  # [D]
│   ├── CanVolunteer.md  # [D]
│   ├── CanVolunteer.mjs  # [D]
│   ├── CanWorkbench.can  # [D]
│   ├── CanWorkbench.md  # [D]
│   ├── CanWorkbench.mjs  # [D]
│   ├── MIGRATION.md  # [D]
│   ├── PORTFOLIO.md  # [D]
│   ├── README.md  # [D]
│   └── WORKSPACE_OPERATOR.md  # [D]
├── editors/
│   └── vscode/
│       ├── audit-astra/
│       │   ├── changed-rule-recheck-20261004T020201Z/
│       │   │   ├── snapshot/
│       │   │   │   ├── editors/
│       │   │   │   │   └── vscode/
│       │   │   │   │       ├── syntaxes/
│       │   │   │   │       │   └── can.tmLanguage.json  # [H]
│       │   │   │   │       └── package.json  # [H]
│       │   │   │   └── GRAMMAR.md  # [H]
│       │   │   ├── sources/
│       │   │   │   ├── inline-do-require.can  # [H]
│       │   │   │   ├── multiline-parenthesized-form.can  # [H]
│       │   │   │   ├── owned-model-app.can  # [H]
│       │   │   │   ├── owned-model-capability.can  # [H]
│       │   │   │   ├── owned-model-contract.can  # [H]
│       │   │   │   ├── owned-model-event.can  # [H]
│       │   │   │   ├── owned-model-package.can  # [H]
│       │   │   │   ├── owned-model-role.can  # [H]
│       │   │   │   └── qualified-migration-targets.can  # [H]
│       │   │   ├── RECHECK.md  # [H]
│       │   │   ├── inline-require-probe.cjs  # [H]
│       │   │   ├── inline-require-theme-evidence.json  # [G]; [H]
│       │   │   ├── inline-require-theme-result.md  # [H]
│       │   │   ├── manifest.json  # [G]; [H]
│       │   │   ├── probe-results.json  # [G]; [H]
│       │   │   ├── probes.json  # [H]
│       │   │   ├── results.txt  # [H]
│       │   │   └── tokenize.cjs  # [H]
│       │   ├── final-changed-files/
│       │   │   ├── draft/
│       │   │   │   ├── shared/
│       │   │   │   │   └── Locations.can  # [H]
│       │   │   │   ├── CanField.can  # [H]
│       │   │   │   ├── CanMaintain.can  # [H]
│       │   │   │   ├── CanMember.can  # [H]
│       │   │   │   └── CanRent.can  # [H]
│       │   │   ├── editors/
│       │   │   │   └── vscode/
│       │   │   │       ├── syntaxes/
│       │   │   │       │   └── can.tmLanguage.json  # [H]
│       │   │   │       ├── README.md  # [H]
│       │   │   │       ├── check-highlighting.cjs  # [H]
│       │   │   │       └── package.json  # [H]
│       │   │   ├── DECISIONS.md  # [H]
│       │   │   └── DESIGN.md  # [H]
│       │   ├── followup-013/
│       │   │   ├── syntaxes/
│       │   │   │   └── can.tmLanguage.json  # [H]
│       │   │   ├── manifest.json  # [H]
│       │   │   └── package.json  # [H]
│       │   ├── latest-extension/
│       │   │   ├── syntaxes/
│       │   │   │   └── can.tmLanguage.json  # [H]
│       │   │   └── package.json  # [H]
│       │   ├── recheck-20261004T014855Z/
│       │   │   ├── execution-sources/
│       │   │   │   ├── valid-backend-context.can  # [H]
│       │   │   │   ├── valid-contextual-models.can  # [H]
│       │   │   │   ├── valid-crud-examples.can  # [H]
│       │   │   │   ├── valid-inline-structural-guards.can  # [H]
│       │   │   │   ├── valid-joined-query.can  # [H]
│       │   │   │   ├── valid-operation-slots.can  # [H]
│       │   │   │   ├── valid-operator-operand-boundaries.can  # [H]
│       │   │   │   ├── valid-owned-contextual-models.can  # [H]
│       │   │   │   ├── valid-qualified-operation-parentheses.can  # [H]
│       │   │   │   ├── valid-query-contextual-names.can  # [H]
│       │   │   │   ├── valid-scenario-examples-contextual.can  # [H]
│       │   │   │   └── valid-ui-query-and-guards.can  # [H]
│       │   │   ├── foundation-can-probes/
│       │   │   │   ├── F4-inline-contextual-type-atoms.can  # [H]
│       │   │   │   ├── F4-multiline-contextual-type-atoms.can  # [H]
│       │   │   │   ├── F4-multiline-signature-types.can  # [H]
│       │   │   │   ├── F6-selector-literal-prefix-names.can  # [H]
│       │   │   │   ├── F6-spaced-signed-and-qualified-selectors.can  # [H]
│       │   │   │   ├── F7-multiline-values-shorthand.can  # [H]
│       │   │   │   ├── F7-route-type-subroles.can  # [H]
│       │   │   │   ├── F7-whitespace-array-suffixes.can  # [H]
│       │   │   │   ├── F8-model-field-handler-shapes.can  # [H]
│       │   │   │   ├── F8-original-maintenance.can  # [H]
│       │   │   │   └── F8-qualified-target-paths.can  # [H]
│       │   │   ├── owned-model-minimal-sources/
│       │   │   │   ├── app.can  # [H]
│       │   │   │   ├── capability.can  # [H]
│       │   │   │   ├── contract.can  # [H]
│       │   │   │   ├── event.can  # [H]
│       │   │   │   ├── package.can  # [H]
│       │   │   │   └── role.can  # [H]
│       │   │   ├── snapshot/
│       │   │   │   ├── editors/
│       │   │   │   │   └── vscode/
│       │   │   │   │       ├── syntaxes/
│       │   │   │   │       │   └── can.tmLanguage.json  # [H]
│       │   │   │   │       └── package.json  # [H]
│       │   │   │   ├── AGENTS.md  # [H]
│       │   │   │   └── GRAMMAR.md  # [H]
│       │   │   ├── RECHECK.md  # [H]
│       │   │   ├── execution-probes.json  # [H]
│       │   │   ├── execution-recheck.md  # [H]
│       │   │   ├── execution-results.json  # [G]; [H]
│       │   │   ├── execution-results.txt  # [H]
│       │   │   ├── execution-tokenize.cjs  # [H]
│       │   │   ├── foundation-probes.json  # [H]
│       │   │   ├── foundation-recheck.md  # [H]
│       │   │   ├── foundation-results.json  # [G]; [H]
│       │   │   ├── foundation-results.txt  # [H]
│       │   │   ├── foundation-tokenize.cjs  # [H]
│       │   │   ├── inline-require-evidence.json  # [G]; [H]
│       │   │   ├── manifest.json  # [G]; [H]
│       │   │   ├── original-probe-results.txt  # [H]
│       │   │   ├── original-probes.json  # [H]
│       │   │   ├── owned-model-minimal-probes.json  # [H]
│       │   │   ├── owned-model-minimal-results.json  # [G]; [H]
│       │   │   ├── owned-model-minimal-results.txt  # [H]
│       │   │   ├── owned-model-minimal.cjs  # [H]
│       │   │   ├── probe-results.json  # [G]; [H]
│       │   │   ├── replay-original.cjs  # [H]
│       │   │   ├── root-focused-probes.json  # [H]
│       │   │   ├── root-focused-results.json  # [G]; [H]
│       │   │   ├── root-focused-results.txt  # [H]
│       │   │   ├── root-focused.cjs  # [H]
│       │   │   ├── source-drift.json  # [G]; [H]
│       │   │   ├── theme-evidence.json  # [G]; [H]
│       │   │   ├── theme-probe.cjs  # [H]
│       │   │   └── theme-report.md  # [H]
│       │   ├── snapshot/
│       │   │   ├── draft/
│       │   │   │   ├── shared/
│       │   │   │   │   ├── Employees.can  # [H]
│       │   │   │   │   ├── Locations.can  # [H]
│       │   │   │   │   └── Suppliers.can  # [H]
│       │   │   │   ├── CanAffiliate.can  # [H]
│       │   │   │   ├── CanApprove.can  # [H]
│       │   │   │   ├── CanBoard.can  # [H]
│       │   │   │   ├── CanBook.can  # [H]
│       │   │   │   ├── CanCRM.can  # [H]
│       │   │   │   ├── CanCatch.can  # [H]
│       │   │   │   ├── CanCheck.can  # [H]
│       │   │   │   ├── CanContract.can  # [H]
│       │   │   │   ├── CanCustomer.can  # [H]
│       │   │   │   ├── CanDesk.can  # [H]
│       │   │   │   ├── CanDo.can  # [H]
│       │   │   │   ├── CanEvent.can  # [H]
│       │   │   │   ├── CanExpense.can  # [H]
│       │   │   │   ├── CanFeedback.can  # [H]
│       │   │   │   ├── CanField.can  # [H]
│       │   │   │   ├── CanGrant.can  # [H]
│       │   │   │   ├── CanHire.can  # [H]
│       │   │   │   ├── CanInvoice.can  # [H]
│       │   │   │   ├── CanLearn.can  # [H]
│       │   │   │   ├── CanLeave.can  # [H]
│       │   │   │   ├── CanLoyalty.can  # [H]
│       │   │   │   ├── CanMail.can  # [H]
│       │   │   │   ├── CanMaintain.can  # [H]
│       │   │   │   ├── CanMember.can  # [H]
│       │   │   │   ├── CanOnboard.can  # [H]
│       │   │   │   ├── CanPropose.can  # [H]
│       │   │   │   ├── CanPurchase.can  # [H]
│       │   │   │   ├── CanReception.can  # [H]
│       │   │   │   ├── CanRefer.can  # [H]
│       │   │   │   ├── CanRent.can  # [H]
│       │   │   │   ├── CanReport.can  # [H]
│       │   │   │   ├── CanShift.can  # [H]
│       │   │   │   ├── CanStats.can  # [H]
│       │   │   │   ├── CanStock.can  # [H]
│       │   │   │   ├── CanSuccess.can  # [H]
│       │   │   │   ├── CanTable.can  # [H]
│       │   │   │   ├── CanTime.can  # [H]
│       │   │   │   ├── CanTrade.can  # [H]
│       │   │   │   └── CanVolunteer.can  # [H]
│       │   │   ├── editors/
│       │   │   │   └── vscode/
│       │   │   │       ├── syntaxes/
│       │   │   │       │   └── can.tmLanguage.json  # [H]
│       │   │   │       ├── GRAMMAR-AUDIT.md  # [H]
│       │   │   │       ├── README.md  # [H]
│       │   │   │       ├── check-highlighting.cjs  # [H]
│       │   │   │       └── package.json  # [H]
│       │   │   ├── examples/
│       │   │   │   ├── ExpenseFlow.can  # [H]
│       │   │   │   └── TeamTasks.can  # [H]
│       │   │   ├── AGENTS.md  # [H]
│       │   │   ├── DECISIONS.md  # [H]
│       │   │   ├── DESIGN.md  # [H]
│       │   │   └── GRAMMAR.md  # [H]
│       │   ├── REPORT.md  # [H]
│       │   ├── build-inventory.py  # [H]
│       │   ├── changed-during-audit.json  # [G]; [H]
│       │   ├── changed-rule-current-path.txt  # [H]
│       │   ├── corpus-tokens.json  # [G]; [H]
│       │   ├── description-probe.cjs  # [H]
│       │   ├── description-results.json  # [G]; [H]
│       │   ├── description-results.txt  # [H]
│       │   ├── execution-presentation-latest-results.json  # [G]; [H]
│       │   ├── execution-presentation-probe-results.json  # [G]; [H]
│       │   ├── execution-presentation-probes.json  # [H]
│       │   ├── execution-presentation-tokenize.cjs  # [H]
│       │   ├── final-file-drift.json  # [G]; [H]
│       │   ├── final-palette-swap-settings.json  # [H]
│       │   ├── followup-013-theme-evidence.json  # [G]; [H]
│       │   ├── followup-013-theme-probe.cjs  # [H]
│       │   ├── followup-013-theme.md  # [H]
│       │   ├── inventory-execution-presentation.md  # [H]
│       │   ├── inventory-foundation.md  # [H]
│       │   ├── latest-corpus-tokens.json  # [G]; [H]
│       │   ├── latest-probe-results.json  # [G]; [H]
│       │   ├── latest-probe-results.txt  # [H]
│       │   ├── probe-results.json  # [G]; [H]
│       │   ├── probe-results.txt  # [H]
│       │   ├── probe-tokenization.cjs  # [H]
│       │   ├── probes.json  # [H]
│       │   ├── production-coverage.csv  # [H]
│       │   ├── recheck-current-path.txt  # [H]
│       │   ├── snapshot-manifest.json  # [G]; [H]
│       │   ├── theme-installation-evidence-005813.json  # [G]; [H]
│       │   ├── theme-installation-evidence-010004.json  # [G]; [H]
│       │   ├── theme-installation-evidence-010146.json  # [G]; [H]
│       │   ├── theme-installation-evidence.json  # [G]; [H]
│       │   ├── theme-installation.md  # [H]
│       │   └── theme-probe.cjs  # [H]
│       ├── src/
│       │   ├── client.ts
│       │   ├── diagnostics.ts  # + proposed; from editors/vscode/src/client.ts
│       │   ├── extension.ts
│       │   └── protocol.ts  # + proposed; from editors/vscode/src/client.ts
│       ├── syntaxes/
│       │   └── can.tmLanguage.json
│       ├── test/
│       │   ├── corpus.cjs  # + proposed; from editors/vscode/check-highlighting.cjs
│       │   ├── engine.cjs  # + proposed; from editors/vscode/check-highlighting.cjs
│       │   ├── palette.cjs  # + proposed; from editors/vscode/check-highlighting.cjs
│       │   └── syntax.cjs  # + proposed; from editors/vscode/check-highlighting.cjs
│       ├── .vscodeignore
│       ├── AUDIT-RESOLUTION.md
│       ├── GRAMMAR-AUDIT.md
│       ├── PALETTE.md
│       ├── README.md
│       ├── audit-resolution-evidence.json  # [G]
│       ├── check-highlighting.cjs
│       ├── package.json
│       ├── palette-evidence.json  # [G]
│       ├── section-style-evidence.json  # [G]
│       └── token-colors.json
├── examples/
│   ├── ExpenseFlow.can
│   └── TeamTasks.can
├── implementation/
│   ├── briefs/
│   │   ├── 05-ui.md
│   │   └── 08-frontend-catalog-migration.md
│   ├── evidence/
│   │   ├── jev/
│   │   │   ├── lane-03-s7-20261004/
│   │   │   │   ├── 1.request.json
│   │   │   │   ├── 1.result.json  # [G]
│   │   │   │   ├── 2.request.json
│   │   │   │   ├── 2.result.json  # [G]
│   │   │   │   ├── 3.request.json
│   │   │   │   └── 3.result.json  # [G]
│   │   │   ├── lane-05-c7-20261004/
│   │   │   │   ├── 1.request.json
│   │   │   │   ├── 1.result.json  # [G]
│   │   │   │   ├── 2.request.json
│   │   │   │   ├── 2.result.json  # [G]
│   │   │   │   ├── 3.request.json
│   │   │   │   ├── 3.result.json  # [G]
│   │   │   │   └── review.md
│   │   │   ├── lane-05-s5-20261004/
│   │   │   │   ├── 1.request.json
│   │   │   │   ├── 1.result.json  # [G]
│   │   │   │   ├── 2.request.json
│   │   │   │   ├── 2.result.json  # [G]
│   │   │   │   ├── 3.request.json
│   │   │   │   ├── 3.result.json  # [G]
│   │   │   │   └── review.md
│   │   │   ├── lane-07-seed-design-20261004/
│   │   │   │   ├── q1.json  # [G]
│   │   │   │   ├── q2.json  # [G]
│   │   │   │   └── q3.json  # [G]
│   │   │   ├── lanes-20261004/
│   │   │   │   ├── 1.request.json
│   │   │   │   ├── 1.result.json  # [G]
│   │   │   │   ├── 2.request.json
│   │   │   │   ├── 2.result.json  # [G]
│   │   │   │   ├── 3.request.json
│   │   │   │   ├── 3.result.json  # [G]
│   │   │   │   ├── 4.request.json
│   │   │   │   ├── 4.result.json  # [G]
│   │   │   │   ├── 5.request.json
│   │   │   │   ├── 5.result.json  # [G]
│   │   │   │   ├── 6.request.json
│   │   │   │   ├── 6.result.json  # [G]
│   │   │   │   ├── five-lane-review.md
│   │   │   │   ├── review.md
│   │   │   │   └── wording.md
│   │   │   └── values-20261004/
│   │   │       ├── context.md
│   │   │       ├── values-20261004-a.questions.json
│   │   │       ├── values-20261004-a.result.json  # [G]
│   │   │       ├── values-20261004-b.questions.json
│   │   │       ├── values-20261004-b.result.json  # [G]
│   │   │       ├── values-20261004-c.questions.json
│   │   │       ├── values-20261004-c.result.json  # [G]
│   │   │       └── values-20261004-review.md
│   │   ├── lane-01-b1/
│   │   │   ├── phase2.md
│   │   │   └── runtime.md
│   │   └── plan-review.md
│   ├── prompts/
│   │   ├── 01-language.md
│   │   ├── 02-values.md
│   │   ├── 03-state.md
│   │   ├── 04-work-services-files.md
│   │   ├── 05-ui-steering.md
│   │   ├── 05-ui.md
│   │   ├── 06-identity-interfaces.md
│   │   ├── 07-platform.md
│   │   ├── 08-frontend-catalog-migration.md
│   │   └── 08-frontend-catalog-steering.md
│   ├── status/
│   │   ├── frontend-catalog-migration.md
│   │   ├── lane-01.md
│   │   ├── lane-02.md
│   │   ├── lane-03.md
│   │   ├── lane-04.md
│   │   ├── lane-05.md
│   │   ├── lane-06.md
│   │   └── lane-07.md
│   ├── CONTRACTS.md
│   ├── DESIGN-DELTA-20261004.md
│   ├── DIAGNOSTICS.md
│   ├── PLAN.md
│   ├── UI-CATALOG-ADOPTION.md
│   └── WORKFLOW.md
├── output/
│   ├── build-in-public/
│   │   ├── canlang-example-do-white-20261004-51f2d7ef.png  # [G]
│   │   ├── canlang-example-do-white-20261004-51f2d7ef.prompt.txt  # [G]
│   │   ├── canlang-new-direction-20261003-ab21457b.png  # [G]
│   │   ├── canlang-new-direction-20261003-ab21457b.prompt.txt  # [G]
│   │   ├── canlang-new-direction-v2-20261003-ac77e429.description.txt  # [G]
│   │   ├── canlang-new-direction-v2-20261003-ac77e429.png  # [G]
│   │   └── canlang-new-direction-v2-20261003-ac77e429.prompt.txt  # [G]
│   └── editor/
│       ├── invariant-category-0.1.7.json  # [G]
│       └── invariant-migration-0.1.6.json  # [G]
├── packages/
│   ├── cloudflare/
│   │   ├── src/
│   │   │   ├── build/
│   │   │   │   ├── artifact.ts  # + proposed; from packages/cloudflare/src/runtime/artifact.ts; Node only
│   │   │   │   └── modules.ts  # + proposed; from packages/cloudflare/src/runtime/modules.ts; Node only
│   │   │   ├── cli/
│   │   │   │   └── platform.ts
│   │   │   ├── deploy/
│   │   │   │   ├── compat.ts
│   │   │   │   └── plan.ts
│   │   │   ├── dev/
│   │   │   │   └── local-run.ts
│   │   │   ├── worker/
│   │   │   │   ├── artifact.ts  # + proposed; from packages/cloudflare/src/worker/assembly.ts
│   │   │   │   ├── assembly.ts
│   │   │   │   ├── entry.ts
│   │   │   │   └── invoker.ts  # + proposed; from packages/cloudflare/src/worker/assembly.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── fixtures/
│   │   │   │   ├── demo-schema.ts  # + proposed; from packages/cloudflare/src/worker/assembly.ts
│   │   │   │   └── smoke-worker.mjs
│   │   │   ├── artifact.test.ts
│   │   │   ├── assembly.test.ts
│   │   │   ├── cli.test.ts
│   │   │   ├── compat.test.ts
│   │   │   ├── dev-smoke.test.ts
│   │   │   ├── invoke.test.ts
│   │   │   ├── modules.test.ts
│   │   │   ├── plan.test.ts
│   │   │   ├── runtime-context.test.ts
│   │   │   ├── runtime-stdlib.test.ts
│   │   │   └── worker-boundary.test.ts
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── contracts/
│   │   ├── src/
│   │   │   ├── presentation/
│   │   │   │   ├── catalog.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── collections.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── components.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── context.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── controls.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── forms.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── groups.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── htmx.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── leaves.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── media.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── messages.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── navigation.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── overlays.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── page.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── panels.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── review.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   ├── settings.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   │   └── shell.ts  # + proposed; from packages/contracts/src/presentation.ts
│   │   │   ├── state/
│   │   │   │   ├── commit.ts  # + proposed; from packages/contracts/src/state.ts
│   │   │   │   ├── identity.ts  # + proposed; from packages/contracts/src/state.ts
│   │   │   │   ├── invocation.ts  # + proposed; from packages/contracts/src/state.ts
│   │   │   │   ├── migration.ts  # + proposed; from packages/contracts/src/state.ts
│   │   │   │   ├── mutation.ts  # + proposed; from packages/contracts/src/state.ts
│   │   │   │   ├── query.ts  # + proposed; from packages/contracts/src/state.ts
│   │   │   │   └── storage.ts  # + proposed; from packages/contracts/src/state.ts
│   │   │   ├── artifact.ts
│   │   │   ├── deployment.ts
│   │   │   ├── diagnostic.ts
│   │   │   ├── examples.ts
│   │   │   ├── files.ts
│   │   │   ├── identity.ts
│   │   │   ├── index.ts
│   │   │   ├── presentation.ts
│   │   │   ├── services.ts
│   │   │   ├── state.ts
│   │   │   ├── values.ts
│   │   │   ├── wire.ts
│   │   │   └── work.ts
│   │   ├── test/
│   │   │   ├── assembly.test.ts
│   │   │   ├── deployment.test.ts
│   │   │   └── examples.test.ts
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── files/
│   │   ├── src/
│   │   │   ├── finalize/
│   │   │   │   └── index.ts
│   │   │   ├── provenance/
│   │   │   │   └── index.ts
│   │   │   ├── retention/
│   │   │   │   └── index.ts
│   │   │   ├── storage/
│   │   │   │   ├── fs.ts  # + proposed; from packages/files/src/upload/fs-blob-store.ts; Node only
│   │   │   │   └── key.ts  # + proposed; from packages/files/src/ports.ts
│   │   │   ├── upload/
│   │   │   │   ├── content.ts  # + proposed; from packages/files/src/upload/index.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── intent.ts  # + proposed; from packages/files/src/upload/index.ts
│   │   │   │   ├── shared.ts  # + proposed; from packages/files/src/upload/index.ts
│   │   │   │   └── validation.ts  # + proposed; from packages/files/src/upload/index.ts
│   │   │   ├── bridge.ts
│   │   │   ├── catalog.ts
│   │   │   ├── ports.ts
│   │   │   ├── scenarios.ts
│   │   │   └── testing.ts  # + proposed; from packages/files/src/ports.ts
│   │   ├── test/
│   │   │   ├── bridge.test.ts
│   │   │   ├── contract-shapes.test.ts
│   │   │   ├── finalize.test.ts
│   │   │   ├── foreign.test.ts
│   │   │   ├── helpers.ts
│   │   │   ├── retention.test.ts
│   │   │   ├── scenarios.test.ts
│   │   │   ├── upload-journey.test.ts
│   │   │   └── validation.test.ts
│   │   ├── .gitignore
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── identity/
│   │   ├── src/
│   │   │   ├── accounts/
│   │   │   │   ├── passwords.ts
│   │   │   │   ├── recovery.ts
│   │   │   │   └── registration.ts
│   │   │   ├── authentication/
│   │   │   │   ├── audience.ts
│   │   │   │   ├── context.ts
│   │   │   │   ├── grants.ts
│   │   │   │   ├── oauth.ts
│   │   │   │   └── revocation.ts
│   │   │   ├── sessions/
│   │   │   │   ├── cookies.ts
│   │   │   │   ├── csrf.ts
│   │   │   │   └── tokens.ts
│   │   │   ├── teams/
│   │   │   │   ├── invitations.ts
│   │   │   │   ├── membership.ts
│   │   │   │   ├── roles.ts
│   │   │   │   └── selection.ts
│   │   │   ├── testing/
│   │   │   │   └── helpers.ts  # + proposed; from packages/identity/src/testing.ts
│   │   │   ├── index.ts
│   │   │   ├── ports.ts
│   │   │   └── testing.ts
│   │   ├── test/
│   │   │   ├── fixtures/
│   │   │   │   ├── revoked-session.json
│   │   │   │   └── two-user-team.json
│   │   │   ├── accounts.test.ts
│   │   │   ├── context.test.ts
│   │   │   ├── contracts.test.ts
│   │   │   ├── grants.test.ts
│   │   │   ├── oauth.test.ts
│   │   │   ├── sessions.test.ts
│   │   │   └── teams.test.ts
│   │   ├── .gitignore
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── interfaces/
│   │   ├── src/
│   │   │   ├── envelope/
│   │   │   │   ├── refs.ts
│   │   │   │   ├── validate.ts
│   │   │   │   └── versions.ts
│   │   │   ├── errors/
│   │   │   │   ├── envelope.ts
│   │   │   │   ├── logging.ts
│   │   │   │   ├── redact.ts
│   │   │   │   └── safe.ts
│   │   │   ├── http/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── context.ts
│   │   │   │   ├── fragments.ts
│   │   │   │   ├── limits.ts
│   │   │   │   ├── operations.ts
│   │   │   │   ├── pages.ts
│   │   │   │   ├── presentation.ts  # + proposed; observed uncommitted constructor from interfaces pages.ts
│   │   │   │   └── routes.ts
│   │   │   ├── ingress/
│   │   │   │   ├── mapping.ts
│   │   │   │   └── routes.ts
│   │   │   ├── mcp/
│   │   │   │   ├── discovery.ts
│   │   │   │   ├── schemas.ts
│   │   │   │   ├── server.ts
│   │   │   │   └── tools.ts
│   │   │   ├── oauth/
│   │   │   │   ├── metadata.ts
│   │   │   │   └── routes.ts
│   │   │   ├── projection/
│   │   │   │   └── project.ts
│   │   │   ├── testing/
│   │   │   │   ├── http.ts  # + proposed; from packages/interfaces/src/testing.ts
│   │   │   │   ├── identity.ts  # + proposed; from packages/interfaces/src/testing.ts
│   │   │   │   ├── ingress.ts  # + proposed; from packages/interfaces/src/testing.ts
│   │   │   │   ├── mcp.ts  # + proposed; from packages/interfaces/src/testing.ts
│   │   │   │   ├── oauth.ts  # + proposed; from packages/interfaces/src/testing.ts
│   │   │   │   └── uploads.ts  # + proposed; from packages/interfaces/src/testing.ts
│   │   │   ├── uploads/
│   │   │   │   ├── principals.ts
│   │   │   │   └── routes.ts
│   │   │   ├── index.ts
│   │   │   ├── ports.ts
│   │   │   └── testing.ts
│   │   ├── test/
│   │   │   ├── fixtures/
│   │   │   │   ├── action-handle.json
│   │   │   │   ├── business-error.json
│   │   │   │   ├── mutation-envelope.json
│   │   │   │   └── upload-intent.json
│   │   │   ├── envelope.test.ts
│   │   │   ├── errors.test.ts
│   │   │   ├── http-auth.test.ts
│   │   │   ├── http-operations.test.ts
│   │   │   ├── http-pages.test.ts
│   │   │   ├── http-presentation.test.ts  # + proposed; observed uncommitted constructor contract tests
│   │   │   ├── ingress.test.ts
│   │   │   ├── integration-lifecycle.test.ts
│   │   │   ├── integration-parity.test.ts
│   │   │   ├── mcp-server.test.ts
│   │   │   ├── mcp-tools.test.ts
│   │   │   ├── oauth.test.ts
│   │   │   ├── projection.test.ts
│   │   │   ├── uploads.test.ts
│   │   │   └── wire.test.ts
│   │   ├── .gitignore
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── services/
│   │   ├── src/
│   │   │   ├── http/
│   │   │   │   ├── body.ts  # + proposed; from packages/services/src/http/client.ts
│   │   │   │   ├── client.ts
│   │   │   │   ├── errors.ts
│   │   │   │   ├── pagination.ts
│   │   │   │   ├── redirects.ts  # + proposed; from packages/services/src/http/client.ts
│   │   │   │   ├── request.ts  # + proposed; from packages/services/src/http/client.ts
│   │   │   │   └── stream.ts  # + proposed; from packages/services/src/http/client.ts
│   │   │   ├── judgments/
│   │   │   │   ├── systemone/
│   │   │   │   │   ├── adapter.ts  # + proposed; from packages/services/src/judgments/systemone.ts
│   │   │   │   │   ├── request.ts  # + proposed; from packages/services/src/judgments/systemone.ts
│   │   │   │   │   └── response.ts  # + proposed; from packages/services/src/judgments/systemone.ts
│   │   │   │   └── systemone.ts
│   │   │   ├── mail/
│   │   │   │   ├── adapter.ts
│   │   │   │   ├── request.ts  # + proposed; from packages/services/src/mail/adapter.ts
│   │   │   │   └── response.ts  # + proposed; from packages/services/src/mail/adapter.ts
│   │   │   ├── media/
│   │   │   │   ├── comfyui/
│   │   │   │   │   ├── adapter.ts  # + proposed; from packages/services/src/media/comfyui.ts
│   │   │   │   │   ├── download.ts  # + proposed; from packages/services/src/media/comfyui.ts
│   │   │   │   │   └── response.ts  # + proposed; from packages/services/src/media/comfyui.ts
│   │   │   │   ├── comfyui.ts
│   │   │   │   └── mapping.ts
│   │   │   ├── models/
│   │   │   │   ├── ollama/
│   │   │   │   │   ├── adapter.ts  # + proposed; from packages/services/src/models/ollama.ts
│   │   │   │   │   ├── request.ts  # + proposed; from packages/services/src/models/ollama.ts
│   │   │   │   │   ├── response.ts  # + proposed; from packages/services/src/models/ollama.ts
│   │   │   │   │   └── run.ts  # + proposed; from packages/services/src/models/ollama.ts
│   │   │   │   └── ollama.ts
│   │   │   ├── testing/
│   │   │   │   ├── harness/
│   │   │   │   │   ├── judgments.ts  # + proposed; from packages/services/src/judgments/harness.ts
│   │   │   │   │   ├── mail.ts  # + proposed; from packages/services/src/ports.ts
│   │   │   │   │   ├── media.ts  # + proposed; from packages/services/src/media/harness.ts
│   │   │   │   │   └── models.ts  # + proposed; from packages/services/src/models/harness.ts
│   │   │   │   ├── scenarios/
│   │   │   │   │   ├── index.ts  # + proposed; from packages/services/src/scenarios.ts
│   │   │   │   │   ├── judgments.ts  # + proposed; from packages/services/src/scenarios.ts
│   │   │   │   │   ├── mail.ts  # + proposed; from packages/services/src/scenarios.ts
│   │   │   │   │   ├── media.ts  # + proposed; from packages/services/src/scenarios.ts
│   │   │   │   │   ├── models.ts  # + proposed; from packages/services/src/scenarios.ts
│   │   │   │   │   └── schema.ts  # + proposed; from packages/services/src/scenarios.ts, packages/testkit/src/fixtures/playback.ts
│   │   │   │   └── helpers.ts  # + proposed; from packages/services/src/ports.ts
│   │   │   ├── catalog.ts
│   │   │   ├── completion.ts  # + proposed; from packages/services/src/mail/adapter.ts
│   │   │   ├── errors.ts  # + proposed; from packages/services/src/mail/redact.ts
│   │   │   ├── ports.ts
│   │   │   ├── runtime.ts  # + proposed; from packages/services/src/ports.ts
│   │   │   └── scenarios.ts
│   │   ├── test/
│   │   │   ├── contract-shapes.test.ts
│   │   │   ├── http-client.test.ts
│   │   │   ├── judgments-systemone.test.ts
│   │   │   ├── mail-adapter.test.ts
│   │   │   ├── mail-redaction.test.ts
│   │   │   ├── media-comfyui.test.ts
│   │   │   ├── models-ollama.test.ts
│   │   │   ├── pagination.test.ts
│   │   │   └── scenarios.test.ts
│   │   ├── .gitignore
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── state/
│   │   ├── src/
│   │   │   ├── effects/
│   │   │   │   └── staging.ts
│   │   │   ├── internal/
│   │   │   │   └── json.ts
│   │   │   ├── invocation/
│   │   │   │   ├── admission.ts
│   │   │   │   ├── context.ts  # consolidates packages/cloudflare/src/runtime/context.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── invoke.ts  # consolidates packages/cloudflare/src/runtime/invoke.ts
│   │   │   │   ├── registry.ts
│   │   │   │   └── replay.ts
│   │   │   ├── migration/
│   │   │   │   ├── validation/
│   │   │   │   │   ├── drops.ts  # + proposed; from packages/state/src/migration/validate.ts
│   │   │   │   │   ├── index.ts  # + proposed; from packages/state/src/migration/validate.ts
│   │   │   │   │   ├── locks.ts  # + proposed; from packages/state/src/migration/validate.ts
│   │   │   │   │   ├── references.ts  # + proposed; from packages/state/src/migration/validate.ts
│   │   │   │   │   ├── rows.ts  # + proposed; from packages/state/src/migration/validate.ts
│   │   │   │   │   └── uniques.ts  # + proposed; from packages/state/src/migration/validate.ts
│   │   │   │   ├── activate.ts
│   │   │   │   ├── directives.ts  # + proposed; from packages/state/src/migration/transition.ts
│   │   │   │   ├── disposition.ts  # + proposed; from packages/state/src/migration/activate.ts
│   │   │   │   ├── evidence.ts  # + proposed; from packages/state/src/migration/activate.ts
│   │   │   │   ├── flip.ts  # + proposed; from packages/state/src/migration/activate.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── mapper.ts
│   │   │   │   ├── model-plan.ts  # + proposed; from packages/state/src/migration/transition.ts
│   │   │   │   ├── owner-plan.ts  # + proposed; from packages/state/src/migration/transition.ts
│   │   │   │   ├── publish.ts  # + proposed; from packages/state/src/migration/activate.ts
│   │   │   │   ├── stage.ts
│   │   │   │   ├── transition.ts
│   │   │   │   └── validate.ts
│   │   │   ├── mutation/
│   │   │   │   ├── candidate.ts  # + proposed; from packages/state/src/mutation/pipeline.ts
│   │   │   │   ├── constraints.ts  # + proposed; from packages/state/src/mutation/pipeline.ts
│   │   │   │   ├── crud.ts
│   │   │   │   ├── history.ts  # + proposed; from packages/state/src/mutation/pipeline.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── models.ts
│   │   │   │   ├── pipeline.ts
│   │   │   │   └── provisional.ts  # + proposed; from packages/state/src/mutation/pipeline.ts
│   │   │   ├── policy/
│   │   │   │   ├── grants.ts
│   │   │   │   ├── path.ts  # + proposed; from packages/state/src/policy/grants.ts
│   │   │   │   ├── predicate.ts  # + proposed; from packages/state/src/policy/grants.ts
│   │   │   │   └── roles.ts
│   │   │   ├── ports/
│   │   │   │   ├── index.ts
│   │   │   │   ├── read.ts
│   │   │   │   ├── system.ts
│   │   │   │   └── transact.ts
│   │   │   ├── query/
│   │   │   │   ├── aggregates.ts  # + proposed; from packages/state/src/query/engine.ts
│   │   │   │   ├── engine.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── order.ts  # + proposed; from packages/state/src/query/engine.ts
│   │   │   │   └── projection.ts  # + proposed; from packages/state/src/query/engine.ts
│   │   │   ├── storage/
│   │   │   │   ├── sql/
│   │   │   │   │   ├── commit-plan.ts  # + proposed; from packages/state/src/storage/d1.ts, packages/state/src/storage/durable-object.ts
│   │   │   │   │   ├── migration-plan.ts  # + proposed; from packages/state/src/storage/d1.ts, packages/state/src/storage/durable-object.ts
│   │   │   │   │   ├── query.ts  # + proposed; from packages/state/src/storage/d1.ts, packages/state/src/storage/durable-object.ts
│   │   │   │   │   └── row-codecs.ts  # + proposed; from packages/state/src/storage/d1.ts, packages/state/src/storage/durable-object.ts
│   │   │   │   ├── d1.ts
│   │   │   │   ├── durable-object.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── port.ts
│   │   │   │   └── schema.ts  # consolidates packages/state/src/storage/d1.ts, packages/state/src/storage/durable-object.ts
│   │   │   ├── testing/
│   │   │   │   ├── memory-probe.ts  # + proposed; from packages/state/src/storage/memory.ts
│   │   │   │   ├── memory-query.ts  # + proposed; from packages/state/src/storage/memory.ts
│   │   │   │   └── memory-storage.ts  # + proposed; from packages/state/src/storage/memory.ts
│   │   │   ├── builtins.ts  # + proposed; from packages/cloudflare/src/runtime/stdlib.ts
│   │   │   ├── catalog.ts
│   │   │   ├── errors.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── invocation/
│   │   │   │   ├── admission.test.ts
│   │   │   │   ├── context.test.ts
│   │   │   │   ├── fixtures.ts
│   │   │   │   ├── invoke.test.ts
│   │   │   │   ├── replay.test.ts
│   │   │   │   └── roles.test.ts
│   │   │   ├── migration/
│   │   │   │   ├── activate.test.ts
│   │   │   │   ├── fixtures.ts
│   │   │   │   ├── invalidate.test.ts
│   │   │   │   ├── resume.test.ts
│   │   │   │   ├── stage.test.ts
│   │   │   │   └── transition.test.ts
│   │   │   ├── mutation/
│   │   │   │   ├── create.test.ts
│   │   │   │   ├── fixtures.ts
│   │   │   │   ├── history.test.ts
│   │   │   │   ├── invariants.test.ts
│   │   │   │   ├── locks.test.ts
│   │   │   │   ├── models.test.ts
│   │   │   │   ├── rejected.test.ts
│   │   │   │   ├── remove.test.ts
│   │   │   │   └── update.test.ts
│   │   │   ├── ports/
│   │   │   │   ├── atomicity.test.ts
│   │   │   │   ├── fixtures.ts
│   │   │   │   ├── read.test.ts
│   │   │   │   ├── staging.test.ts
│   │   │   │   ├── system.test.ts
│   │   │   │   └── transact.test.ts
│   │   │   ├── query/
│   │   │   │   ├── aggregates.test.ts
│   │   │   │   ├── authority.test.ts
│   │   │   │   ├── fixtures.ts
│   │   │   │   ├── projection.test.ts
│   │   │   │   ├── scope.test.ts
│   │   │   │   └── visibility.test.ts
│   │   │   ├── storage/
│   │   │   │   ├── conformance.ts
│   │   │   │   ├── d1.test.ts
│   │   │   │   ├── do-test-worker.js
│   │   │   │   ├── do.test.ts
│   │   │   │   └── memory.test.ts
│   │   │   └── scaffold.test.ts
│   │   ├── .gitignore
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── stdlib/
│   │   ├── src/
│   │   │   └── index.ts  # consolidates packages/cloudflare/src/runtime/stdlib.ts
│   │   ├── test/
│   │   │   └── assembly.test.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── testkit/
│   │   ├── src/
│   │   │   ├── assertions/
│   │   │   │   └── equal.ts
│   │   │   ├── fixtures/
│   │   │   │   ├── accounts.ts
│   │   │   │   ├── playback.ts
│   │   │   │   └── seeds.ts
│   │   │   ├── playback/
│   │   │   │   ├── body.ts  # + proposed; from packages/testkit/src/fixtures/playback.ts
│   │   │   │   ├── handler.ts  # + proposed; from packages/testkit/src/fixtures/playback.ts
│   │   │   │   ├── judgments.ts  # + proposed; from packages/testkit/src/fixtures/playback.ts
│   │   │   │   ├── mail.ts  # + proposed; from packages/testkit/src/fixtures/playback.ts
│   │   │   │   ├── media.ts  # + proposed; from packages/testkit/src/fixtures/playback.ts
│   │   │   │   ├── models.ts  # + proposed; from packages/testkit/src/fixtures/playback.ts
│   │   │   │   └── worker.ts  # + proposed; from packages/testkit/src/fixtures/playback-worker.ts
│   │   │   ├── reporting/
│   │   │   │   └── report.ts
│   │   │   ├── runner/
│   │   │   │   ├── loader.ts
│   │   │   │   └── table.ts
│   │   │   ├── scopes/
│   │   │   │   └── local.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── fixtures/
│   │   │   │   └── scope-worker.mjs
│   │   │   ├── accounts.test.ts
│   │   │   ├── equal.test.ts
│   │   │   ├── isolation.test.ts
│   │   │   ├── loader.test.ts
│   │   │   ├── playback.test.ts
│   │   │   ├── report.test.ts
│   │   │   ├── seeds.test.ts
│   │   │   └── table.test.ts
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── ui/
│   │   ├── src/
│   │   │   ├── collections/
│   │   │   │   ├── board.ts  # + proposed; from packages/ui/src/collections.ts
│   │   │   │   ├── controls.ts  # + proposed; from packages/ui/src/collections.ts
│   │   │   │   ├── csv-import.ts  # + proposed; from packages/ui/src/collections.ts
│   │   │   │   ├── internal.ts  # + proposed; from packages/ui/src/collections.ts
│   │   │   │   └── rows.ts  # + proposed; from packages/ui/src/collections.ts
│   │   │   ├── controls/
│   │   │   │   ├── calendar.ts  # + proposed; from packages/ui/src/controls.ts
│   │   │   │   ├── choice.ts  # + proposed; from packages/ui/src/controls.ts
│   │   │   │   ├── file.ts  # + proposed; from packages/ui/src/controls.ts
│   │   │   │   ├── numeric.ts  # + proposed; from packages/ui/src/controls.ts
│   │   │   │   ├── scalar.ts  # + proposed; from packages/ui/src/controls.ts
│   │   │   │   └── unit.ts  # + proposed; from packages/ui/src/controls.ts
│   │   │   ├── forms/
│   │   │   │   ├── actions.ts  # + proposed; from packages/ui/src/forms.ts
│   │   │   │   ├── field-binding.ts  # + proposed; from packages/ui/src/forms.ts
│   │   │   │   ├── field-value.ts  # + proposed; from packages/ui/src/forms.ts
│   │   │   │   ├── form.ts  # + proposed; from packages/ui/src/forms.ts
│   │   │   │   └── outcomes.ts  # + proposed; from packages/ui/src/forms.ts
│   │   │   ├── navigation/
│   │   │   │   ├── controls.ts  # + proposed; from packages/ui/src/navigation.ts
│   │   │   │   └── discovery.ts  # + proposed; from packages/ui/src/navigation.ts
│   │   │   ├── appearance.ts
│   │   │   ├── catalog.ts
│   │   │   ├── collections.ts
│   │   │   ├── components.ts
│   │   │   ├── controls.ts
│   │   │   ├── escape.ts
│   │   │   ├── format.ts  # + proposed; from packages/ui/src/messages.ts
│   │   │   ├── forms.ts
│   │   │   ├── groups.ts
│   │   │   ├── htmx.ts
│   │   │   ├── index.ts
│   │   │   ├── leaves.ts
│   │   │   ├── media.ts
│   │   │   ├── messages.ts
│   │   │   ├── navigation.ts
│   │   │   ├── overlays.ts
│   │   │   ├── panels.ts
│   │   │   ├── review.ts
│   │   │   ├── settings.ts
│   │   │   └── shell.ts
│   │   ├── test/
│   │   │   ├── fixtures/
│   │   │   │   └── descriptors.ts
│   │   │   ├── appearance.test.ts
│   │   │   ├── catalog.test.ts
│   │   │   ├── collections.test.ts
│   │   │   ├── components.test.ts
│   │   │   ├── controls.test.ts
│   │   │   ├── escape.test.ts
│   │   │   ├── forms.test.ts
│   │   │   ├── groups.test.ts
│   │   │   ├── harness.ts
│   │   │   ├── htmx.test.ts
│   │   │   ├── journeys.test.ts
│   │   │   ├── leaves.test.ts
│   │   │   ├── media.test.ts
│   │   │   ├── messages.test.ts
│   │   │   ├── navigation.test.ts
│   │   │   ├── overlays.test.ts
│   │   │   ├── panels.test.ts
│   │   │   ├── review.test.ts
│   │   │   ├── settings.test.ts
│   │   │   ├── shell.test.ts
│   │   │   └── themes.test.ts
│   │   ├── .gitignore
│   │   ├── README.md
│   │   ├── package.json
│   │   ├── themes.css
│   │   └── tsconfig.json
│   ├── values/
│   │   ├── conformance/
│   │   │   └── v1/
│   │   │       ├── README.md
│   │   │       └── values.json
│   │   ├── scripts/
│   │   │   └── emit-catalog.mjs
│   │   ├── src/
│   │   │   ├── icu/
│   │   │   │   ├── descriptor.ts  # + proposed; from packages/values/src/icu.ts
│   │   │   │   ├── number.ts  # + proposed; from packages/values/src/icu.ts
│   │   │   │   ├── parser.ts  # + proposed; from packages/values/src/icu.ts
│   │   │   │   ├── render.ts  # + proposed; from packages/ui/src/messages.ts, packages/values/src/icu.ts
│   │   │   │   └── validation.ts  # + proposed; from packages/values/src/icu.ts
│   │   │   ├── schema/
│   │   │   │   ├── bounds.ts  # + proposed; from packages/values/src/schema.ts
│   │   │   │   ├── descriptor.ts  # + proposed; from packages/values/src/schema.ts
│   │   │   │   ├── normalize.ts  # + proposed; from packages/values/src/schema.ts
│   │   │   │   ├── omission.ts  # + proposed; from packages/values/src/schema.ts
│   │   │   │   └── validate.ts  # + proposed; from packages/values/src/schema.ts
│   │   │   ├── temporal/
│   │   │   │   ├── calendar.ts  # + proposed; from packages/values/src/temporal.ts
│   │   │   │   ├── duration.ts  # + proposed; from packages/values/src/temporal.ts
│   │   │   │   └── instant.ts  # + proposed; from packages/values/src/temporal.ts
│   │   │   ├── wire/
│   │   │   │   ├── decode.ts  # + proposed; from packages/values/src/wire.ts
│   │   │   │   ├── encode.ts  # + proposed; from packages/values/src/wire.ts
│   │   │   │   └── errors.ts  # + proposed; from packages/values/src/wire.ts
│   │   │   ├── array.ts
│   │   │   ├── catalog.ts
│   │   │   ├── currency-data.ts
│   │   │   ├── decimal.ts
│   │   │   ├── equality.ts
│   │   │   ├── errors.ts
│   │   │   ├── icu.ts
│   │   │   ├── index.ts
│   │   │   ├── int.ts
│   │   │   ├── kinds.ts
│   │   │   ├── locale.ts  # consolidates packages/ui/src/messages.ts
│   │   │   ├── money.ts
│   │   │   ├── schema.ts
│   │   │   ├── stdlib-pure.ts
│   │   │   ├── temporal.ts
│   │   │   ├── text.ts
│   │   │   ├── timezone.ts
│   │   │   ├── types.ts
│   │   │   └── wire.ts
│   │   ├── test/
│   │   │   ├── array.test.ts
│   │   │   ├── catalog.test.ts
│   │   │   ├── conformance.test.ts
│   │   │   ├── decimal-oracle.test.ts
│   │   │   ├── decimal.test.ts
│   │   │   ├── equality.test.ts
│   │   │   ├── errors.test.ts
│   │   │   ├── exports-conformance.test.ts
│   │   │   ├── icu.test.ts
│   │   │   ├── index.test.ts
│   │   │   ├── int.test.ts
│   │   │   ├── kinds.test.ts
│   │   │   ├── locale.test.ts
│   │   │   ├── money.test.ts
│   │   │   ├── schema.test.ts
│   │   │   ├── stdlib-pure.test.ts
│   │   │   ├── temporal.test.ts
│   │   │   ├── text.test.ts
│   │   │   ├── timezone.test.ts
│   │   │   ├── types.test.ts
│   │   │   └── wire.test.ts
│   │   ├── .gitignore
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── work/
│       ├── src/
│       │   ├── dispatch/
│       │   │   └── index.ts
│       │   ├── event/
│       │   │   └── index.ts
│       │   ├── intent/
│       │   │   └── index.ts
│       │   ├── kernel/
│       │   │   ├── commands/
│       │   │   │   ├── arguments.ts  # + proposed; from packages/work/src/kernel/commands.ts
│       │   │   │   ├── dispatch.ts  # + proposed; from packages/work/src/kernel/commands.ts
│       │   │   │   ├── every.ts  # + proposed; from packages/work/src/kernel/commands.ts
│       │   │   │   ├── occurrence.ts  # + proposed; from packages/work/src/kernel/commands.ts
│       │   │   │   └── schedule.ts  # + proposed; from packages/work/src/kernel/commands.ts
│       │   │   ├── tables/
│       │   │   │   ├── dispatch.ts  # + proposed; from packages/work/src/kernel/tables.ts
│       │   │   │   ├── every.ts  # + proposed; from packages/work/src/kernel/tables.ts
│       │   │   │   ├── occurrence.ts  # + proposed; from packages/work/src/kernel/tables.ts
│       │   │   │   ├── row.ts  # + proposed; from packages/work/src/kernel/tables.ts
│       │   │   │   ├── schedule.ts  # + proposed; from packages/work/src/kernel/tables.ts
│       │   │   │   └── supersession.ts  # + proposed; from packages/work/src/kernel/tables.ts
│       │   │   ├── commands.ts
│       │   │   └── tables.ts
│       │   ├── observation/
│       │   │   ├── association.ts
│       │   │   ├── observation.ts
│       │   │   ├── ports.ts
│       │   │   └── testing.ts  # + proposed; from packages/work/src/observation/ports.ts
│       │   ├── receipt/
│       │   │   └── index.ts
│       │   ├── recovery/
│       │   │   └── index.ts
│       │   ├── schedule/
│       │   │   ├── every.ts
│       │   │   └── index.ts
│       │   ├── catalog.ts
│       │   ├── ports.ts
│       │   └── testing.ts  # + proposed; from packages/work/src/ports.ts
│       ├── test/
│       │   ├── contract-shapes.test.ts
│       │   ├── dispatch.test.ts
│       │   ├── event.test.ts
│       │   ├── every.test.ts
│       │   ├── intent.test.ts
│       │   ├── kernel-commands.test.ts
│       │   ├── kernel-tables.test.ts
│       │   ├── observation-association.test.ts
│       │   ├── observation.test.ts
│       │   ├── receipt.test.ts
│       │   ├── recovery.test.ts
│       │   └── schedule.test.ts
│       ├── .gitignore
│       ├── package.json
│       └── tsconfig.json
├── tests/
│   ├── e2e/
│   │   ├── apps/
│   │   │   ├── scaffold.spec.ts
│   │   │   └── teamtasks.spec.ts
│   │   ├── bridges/
│   │   │   └── http-bridge.ts
│   │   ├── fixtures/
│   │   │   ├── handbuilt/
│   │   │   │   ├── teamtasks-worker.mjs
│   │   │   │   └── teamtasks.ts
│   │   │   ├── artifact-loader.ts
│   │   │   ├── e2e-test.ts
│   │   │   └── seed.ts
│   │   └── tsconfig.json
│   └── integration/
│       ├── README.md
│       ├── b1-team-tasks.md
│       ├── lane02-values.test.ts
│       └── readiness.test.ts
├── tools/
│   ├── README.md
│   ├── can_parser.py
│   ├── jev.py
│   ├── test_can_parser.py
│   └── test_jev.py
├── .gitignore
├── .gitmodules
├── AGENTS.md
├── DECISIONS.md
├── DESIGN.md
├── EVALUATION.md
├── GRAMMAR.md
├── README.md
├── REQUIREMENTS.md
├── bun.lock
├── package.json
├── playwright.config.ts
├── tsconfig.base.json
├── tsconfig.check.json
└── vitest.config.ts
```

| Current tracked area | Parent paths | Disposition |
| --- | ---: | --- |
| `(root files and draft gitlink)` | 16 | Exact filenames above; exceptions table overrides same-path retention. |
| `.github` | 10 | Exact filenames above; exceptions table overrides same-path retention. |
| `compiler` | 51 | Exact filenames above; exceptions table overrides same-path retention. |
| `design` | 1114 | Exact filenames above; exceptions table overrides same-path retention. |
| `docs` | 2 | Exact filenames above; exceptions table overrides same-path retention. |
| `editors` | 201 | Exact filenames above; exceptions table overrides same-path retention. |
| `examples` | 2 | Exact filenames above; exceptions table overrides same-path retention. |
| `implementation` | 75 | Exact filenames above; exceptions table overrides same-path retention. |
| `output` | 9 | Exact filenames above; exceptions table overrides same-path retention. |
| `packages` | 399 | Exact filenames above; exceptions table overrides same-path retention. |
| `tests` | 13 | Exact filenames above; exceptions table overrides same-path retention. |
| `tools` | 5 | Exact filenames above; exceptions table overrides same-path retention. |
| Total | 1897 | 1896 blobs plus one `draft` gitlink. |

Coverage: all **1897** parent paths resolve to exactly one disposition through same-path retention or the exception table; every destination appears in the selected tree. The separate submodule contains **148** retained files. The selected parent tree has **2148** leaves, including the retained gitlink and this new document; **270** future new paths and **20** replaced/moved original leaf paths. Shared destinations represent the explicit consolidations in the table. No current parent path is silently omitted. The new document is outside the committed source count until saved in Git by a later authorized action.

### Generated and historical artifacts

Preserve baseline SHA256SUMS and snapshot manifests with their exact source bytes and relative paths. Frozen `AGENTS.md`, package manifests, scripts and app targets are evidence; they are not live contributor instructions, install roots or runtime mirrors. Do not run nested installs or port fixes into frozen snapshots.

Tracked JEV request/response JSON, connection-failure records, adoption measurements, editor token/palette captures and output/editor migration captures are evidence. Preserve confidence, probabilities, model IDs, context and failed/unknown results. The largest editor token arrays are about 16.8 MB each; their size earns classification and provenance review, not algorithm splitting. PNG posters and their prompt/description text are publication assets. Preserve them; do not generate a new poster for this research round.

Ignored build products derive from their existing owners: Rust target binaries, package dist JS/declarations/maps/catalog, editor out and packaged extension, workflow release archives, test/browser reports and local database caches. Their proposed output layout and final sizes remain unverified; changing source folders can alter inferred tsc roots, which is why dist-dependent consumers are named above. Do not move generated files into source to make imports pass.

### Oversized implementation and test inspection ledger

Trigger: more than 500 physical lines or 30 KiB. Every listed implementation was inspected beyond its filename/size. Counts are current committed observations; P includes body/comments/data/blank lines (historical witness bodies are not production), T is a terminal Rust test block, a dedicated test file or a deferred MJS example-fixture function. JSON evidence and binary assets are classified separately above. All final decomposed sizes remain unverified.

| Current path | Bytes | P / T lines | Responsibility / selected disposition |
| --- | ---: | ---: | --- |
| `compiler/src/analysis/catalog.rs` | 40,398 | 1,131 / 0 | Retain cohesive catalog intake/fallback/signature implementation and public lookup/load API. |
| `compiler/src/analysis/effects.rs` | 149,117 | 4,084 / 0 | split; boundaries and every destination specified above. |
| `compiler/src/analysis/examples.rs` | 110,264 | 3,075 / 0 | split; boundaries and every destination specified above. |
| `compiler/src/analysis/resolve.rs` | 189,602 | 5,081 / 0 | split; boundaries and every destination specified above. |
| `compiler/src/analysis/types.rs` | 525,962 | 13,167 / 0 | split; boundaries and every destination specified above. |
| `compiler/src/cli.rs` | 37,355 | 953 / 0 | Retain command dispatch, shared analysis and existing platform passthrough in one CLI file. |
| `compiler/src/codegen/ir.rs` | 239,461 | 6,324 / 0 | split; boundaries and every destination specified above. |
| `compiler/src/codegen/js.rs` | 124,997 | 3,142 / 0 | split; boundaries and every destination specified above. |
| `compiler/src/explain.rs` | 77,524 | 982 / 45 | Retain 110-entry static catalog and render/lookup API+unit tests. Only~112 lines are lookup/rendering; size largely CodeInfo data. Do not scatter diagnostic descriptions across feature files. |
| `compiler/src/format.rs` | 29,218 | 714 / 0 | Retain coherent formatting emitter/spacing rules; no test-driven size issue. |
| `compiler/src/ide/queries.rs` | 53,218 | 1,421 / 0 | consolidate-pure-helpers; boundaries and every destination specified above. |
| `compiler/src/lint/rules.rs` | 45,349 | 1,264 / 0 | consolidate-pure-helpers; boundaries and every destination specified above. |
| `compiler/src/lsp/server.rs` | 56,070 | 1,245 / 280 | split; boundaries and every destination specified above. |
| `compiler/src/syntax/layout.rs` | 31,617 | 752 / 121 | Retain logical lines/descriptions/attachment nesting and inline tests; could split description decoder later but cohesive now. |
| `compiler/src/syntax/lexer.rs` | 30,491 | 814 / 106 | Retain token/physical line/scanner/string decoder and tests; splitting tokens/scanning isn't a semantic need. |
| `compiler/src/syntax/parser.rs` | 244,911 | 6,136 / 0 | split; boundaries and every destination specified above. |
| `compiler/tests/analysis.rs` | 64,553 | 0 / 1,406 | retain target and split cases; boundaries and every destination specified above. |
| `compiler/tests/authoring.rs` | 34,187 | 0 / 912 | Retain current owning outcome matrix and shared setup; selected analysis/codegen/syntax child files are specified in the exception table. |
| `compiler/tests/check.rs` | 39,589 | 0 / 939 | Retain current owning outcome matrix and shared setup; selected analysis/codegen/syntax child files are specified in the exception table. |
| `compiler/tests/codegen.rs` | 107,475 | 0 / 2,970 | retain target and split cases; boundaries and every destination specified above. |
| `compiler/tests/effects.rs` | 30,632 | 0 / 1,025 | Retain current owning outcome matrix and shared setup; selected analysis/codegen/syntax child files are specified in the exception table. |
| `compiler/tests/ide.rs` | 30,509 | 0 / 813 | Retain current owning outcome matrix and shared setup; selected analysis/codegen/syntax child files are specified in the exception table. |
| `compiler/tests/lint.rs` | 30,137 | 0 / 745 | Retain current owning outcome matrix and shared setup; selected analysis/codegen/syntax child files are specified in the exception table. |
| `compiler/tests/syntax.rs` | 61,098 | 0 / 1,590 | retain target and split cases; boundaries and every destination specified above. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanApprove.mjs` | 34,475 | 698 / 296 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanBoard.mjs` | 43,319 | 883 / 366 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCRM.mjs` | 51,678 | 1,117 / 344 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanCheck.mjs` | 32,267 | 637 / 295 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanExpense.mjs` | 33,985 | 672 / 358 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanFeedback.mjs` | 37,358 | 682 / 405 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanGrant.mjs` | 50,404 | 1,045 / 438 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanHire.mjs` | 62,484 | 1,365 / 305 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLeave.mjs` | 51,866 | 1,122 / 373 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanLoyalty.mjs` | 64,413 | 1,123 / 741 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMail.mjs` | 72,744 | 1,541 / 513 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMaintain.mjs` | 71,745 | 1,694 / 275 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanOnboard.mjs` | 30,413 | 779 / 112 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanPurchase.mjs` | 76,822 | 1,757 / 431 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanRefer.mjs` | 53,704 | 1,123 / 391 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanRent.mjs` | 332,359 | 8,171 / 714 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanShift.mjs` | 78,774 | 2,023 / 254 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanStock.mjs` | 40,172 | 949 / 200 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanTable.mjs` | 42,937 | 733 / 467 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanTime.mjs` | 55,539 | 1,286 / 297 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanVolunteer.mjs` | 51,799 | 1,318 / 145 | Frozen source witness/probe; retain exact bytes, metadata/registry/rendering/test-recipe boundaries. |
| `editors/vscode/check-highlighting.cjs` | 35,335 | 267 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `editors/vscode/src/client.ts` | 20,111 | 627 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/cloudflare/src/worker/assembly.ts` | 28,203 | 706 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/contracts/src/presentation.ts` | 58,098 | 1,686 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/contracts/src/state.ts` | 23,355 | 608 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/files/src/upload/index.ts` | 17,233 | 503 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/interfaces/src/testing.ts` | 18,929 | 543 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/interfaces/test/http-pages.test.ts` | 21,947 | 0 / 546 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/interfaces/test/integration-lifecycle.test.ts` | 26,849 | 0 / 754 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/interfaces/test/integration-parity.test.ts` | 30,048 | 0 / 844 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/interfaces/test/mcp-server.test.ts` | 27,707 | 0 / 789 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/interfaces/test/oauth.test.ts` | 20,871 | 0 / 536 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/interfaces/test/uploads.test.ts` | 31,867 | 0 / 883 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/services/src/http/client.ts` | 16,959 | 571 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/services/src/judgments/systemone.ts` | 25,442 | 806 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/services/src/mail/adapter.ts` | 20,570 | 675 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/services/src/media/comfyui.ts` | 22,566 | 676 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/services/src/models/ollama.ts` | 23,140 | 744 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/services/src/scenarios.ts` | 28,534 | 962 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/services/test/judgments-systemone.test.ts` | 22,027 | 0 / 667 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/services/test/media-comfyui.test.ts` | 24,700 | 0 / 764 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/services/test/models-ollama.test.ts` | 22,269 | 0 / 646 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/services/test/scenarios.test.ts` | 31,757 | 0 / 998 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/state/src/migration/activate.ts` | 28,511 | 774 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/state/src/migration/transition.ts` | 29,266 | 793 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/state/src/migration/validate.ts` | 31,727 | 850 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/state/src/mutation/pipeline.ts` | 29,517 | 818 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/state/src/policy/grants.ts` | 17,114 | 519 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/state/src/query/engine.ts` | 28,176 | 837 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/state/src/storage/d1.ts` | 46,158 | 1,250 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/state/src/storage/durable-object.ts` | 45,921 | 1,294 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/state/src/storage/memory.ts` | 36,750 | 978 / 0 | move; boundaries and every destination specified above. |
| `packages/state/test/invocation/admission.test.ts` | 18,237 | 0 / 523 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/state/test/invocation/invoke.test.ts` | 23,106 | 0 / 670 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/state/test/migration/activate.test.ts` | 38,463 | 0 / 1,067 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/state/test/migration/stage.test.ts` | 43,082 | 0 / 1,319 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/state/test/migration/transition.test.ts` | 21,909 | 0 / 620 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/state/test/storage/conformance.ts` | 95,784 | 0 / 2,622 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/testkit/src/fixtures/playback.ts` | 37,419 | 1,228 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/testkit/test/playback.test.ts` | 32,388 | 0 / 1,036 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/src/catalog.ts` | 34,886 | 126 / 0 | Retain coherent owning responsibility; source and affected consumers inspected. |
| `packages/ui/src/collections.ts` | 39,372 | 1,036 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/ui/src/controls.ts` | 38,943 | 1,058 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/ui/src/forms.ts` | 36,364 | 1,038 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/ui/src/messages.ts` | 39,438 | 1,080 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/ui/src/navigation.ts` | 28,481 | 709 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/ui/test/collections.test.ts` | 78,596 | 0 / 2,204 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/test/controls.test.ts` | 35,334 | 0 / 961 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/test/forms.test.ts` | 50,111 | 0 / 1,336 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/test/groups.test.ts` | 21,640 | 0 / 563 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/test/htmx.test.ts` | 20,642 | 0 / 583 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/test/journeys.test.ts` | 30,002 | 0 / 774 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/test/leaves.test.ts` | 26,496 | 0 / 726 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/test/navigation.test.ts` | 47,490 | 0 / 1,386 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/test/overlays.test.ts` | 29,823 | 0 / 863 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/test/panels.test.ts` | 20,088 | 0 / 578 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/ui/test/shell.test.ts` | 36,365 | 0 / 1,113 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/values/src/icu.ts` | 41,372 | 1,133 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/values/src/schema.ts` | 57,043 | 1,797 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/values/src/temporal.ts` | 21,717 | 554 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/values/src/wire.ts` | 58,597 | 1,761 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/values/test/icu.test.ts` | 23,080 | 0 / 530 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/values/test/schema.test.ts` | 39,994 | 0 / 1,012 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/values/test/temporal.test.ts` | 20,784 | 0 / 501 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/values/test/wire.test.ts` | 44,330 | 0 / 940 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/work/src/kernel/commands.ts` | 33,328 | 1,005 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/work/src/kernel/tables.ts` | 19,566 | 578 / 0 | split-with-existing-entry; boundaries and every destination specified above. |
| `packages/work/test/kernel-commands.test.ts` | 38,524 | 0 / 1,332 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `packages/work/test/observation.test.ts` | 18,691 | 0 / 590 | Retain owning outcome matrix; optional independent family splits described above, shared state/journeys preserved. |
| `tests/integration/lane02-values.test.ts` | 24,265 | 0 / 590 | Retain values/catalog/compiler consumer matrix; this is a dedicated integration test, not production code. |
| `tools/can_parser.py` | 67,112 | 1,348 / 0 | Syntax tooling: Cursor/token expressions plus Parser/declarations; retain pending parity/retirement gate. |
| `tools/test_can_parser.py` | 31,925 | 0 / 503 | Retain coherent owning responsibility; source and affected consumers inspected. |

The independent draft’s oversized targets retain their metadata, registry/renderer and deferred-test boundaries; none is production code merely because it has an `.mjs` extension.

| Submodule target | Bytes | Total lines | Test recipe begins | Disposition |
| --- | ---: | ---: | ---: | --- |
| `draft/CanApprove.mjs` | 71,751 | 1,460 | 867 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanBoard.mjs` | 51,910 | 1,416 | 1051 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanCRM.mjs` | 80,628 | 2,019 | 1634 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanChat.mjs` | 36,423 | 283 | 236 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanCheck.mjs` | 36,693 | 951 | 664 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanCreative.mjs` | 38,185 | 223 | 181 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanDiscover.mjs` | 59,928 | 1,201 | 1130 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanExpense.mjs` | 108,261 | 2,349 | 1283 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanFeedback.mjs` | 77,300 | 1,754 | 1188 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanGrant.mjs` | 102,340 | 2,179 | 1353 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanHire.mjs` | 82,872 | 2,090 | 1766 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanInbox.mjs` | 70,182 | 673 | 499 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanInvoice.mjs` | 46,860 | 1,165 | frontend only | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanKnowledge.mjs` | 51,257 | 334 | 231 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanLeave.mjs` | 70,368 | 1,792 | 1383 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanLoyalty.mjs` | 76,555 | 2,138 | 1345 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanMail.mjs` | 97,595 | 2,380 | 1879 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanMaintain.mjs` | 106,720 | 2,379 | 1947 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanMember.mjs` | 52,777 | 1,545 | frontend only | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanOnboard.mjs` | 46,646 | 1,154 | 977 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanPropose.mjs` | 22,852 | 546 | frontend only | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanPurchase.mjs` | 110,945 | 2,880 | 2450 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanReception.mjs` | 27,283 | 727 | frontend only | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanRefer.mjs` | 60,587 | 1,671 | 1281 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanRent.mjs` | 428,635 | 10,760 | 9814 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanShift.mjs` | 91,725 | 2,362 | 2055 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanStock.mjs` | 56,548 | 1,444 | 1245 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanTable.mjs` | 54,482 | 1,437 | 971 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanTime.mjs` | 67,960 | 1,772 | 1456 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanVolunteer.mjs` | 63,279 | 1,644 | 1448 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |
| `draft/CanWorkbench.mjs` | 29,018 | 583 | 518 | Retain desired-output witness; metadata/registry/page/test boundaries inspected. |

### Oversized `.can` declarations and colocated example specifications

All 35 files were read and their app/package declarations, data/interface owners, roles/read policies, scenario/handler and `do` boundaries, UI bindings, fixtures and attached examples inspected. Re-observed bytes/physical lines match the inventory. Production-purpose declarative models/contracts/authority/guards/effects are distinct from test-only `fixture` recipes and attached `examples`; counts below are declaration/block breadth, not executed test coverage or semantic proof.

**Selected disposition: retain all paths.** The 18 live sources remain in the independent pinned draft submodule, preserving authored app/composition and canonical owner identities. The 17 historical baseline/editor-audit/layout/provider variants preserve exact evaluated bytes, original permission/ordering/example context and provenance; shared domain names do not make them duplicate live owners. Their older scopes are not silently upgraded to later contracts. These are draft source designs and evidence, not implemented runtimes. Existing owner/section seams aid navigation; size alone does not warrant wrappers, engines, renamed owners or source splits. No tree change is proposed.

| Current path | Bytes | Lines | Actual responsibility seams; source/test distinction |
| --- | ---: | ---: | --- |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanEvent.can` | 55,946 | 510 | Historical variant — events/invoice: published-event versus attendee/staff policies, registration/venue-change/payment/refund/notice handlers. 10 policy clauses; test-only 7 fixtures / 17 example blocks. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanInvoice.can` | 67,797 | 703 | Historical variant — invoice/Finance: invoice/lines, payment/credit/refund/reconciliation attempts and document/billing ingress; original finance/customer policies. 18 policy clauses; test-only 8 fixtures / 19 example blocks. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMail.can` | 32,108 | 293 | Historical variant — mailroom: service/delegate/item/handling/dispatch, charge/reconciliation and notice callbacks; original staff/recipient read grants. 8 policy clauses; test-only 5 fixtures / 10 example blocks. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMaintain.can` | 31,753 | 307 | Historical variant — maintain/Facilities: asset/plan/inspection/repair/assignment, generate/remind/room-downtime handlers; original manager/technician policies. 9 policy clauses; test-only 4 fixtures / 7 example blocks. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanMember.can` | 64,886 | 689 | Historical variant — member_plans/terms/content: plan/benefit, term/seat/allowance request fences, renewal/payment/access handlers; original owner/manager/editor grants. 21 policy clauses; test-only 15 fixtures / 13 example blocks. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanPropose.can` | 32,943 | 314 | Historical variant — propose: proposal/revision/item, document/recipient decision, hold/book/release and original bounded expiry; salesperson/recipient grants. 5 policy clauses; test-only 3 fixtures / 8 example blocks. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanPurchase.can` | 32,039 | 343 | Historical variant — purchase/supplier: budget/request/order/receipt, additive amendments, returns/stock/payable recovery; original approval/location policies. 13 policy clauses; test-only 7 fixtures / 7 example blocks. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanReception.can` | 32,940 | 346 | Historical variant — reception: visit/host/credential/issue, membership/device/access/notice handlers; original reception/access/host policies. 8 policy clauses; test-only 5 fixtures / 4 example blocks. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanRent.can` | 155,261 | 1,351 | Historical variant — catalog-UI/reservations/fulfillment/reporting + Workspace: capacity/venue/quote/move, payment/allowance and recovery handlers; original resource/account grants. 32 policy clauses; test-only 5 fixtures / 10 example blocks. |
| `design/evaluation/baseline-20261004T041647Z/snapshot/draft/CanShift.can` | 37,419 | 327 | Historical variant — shift/StaffScheduling: roster/availability/commitment/swap and connected scheduling/reconciliation; original scheduler/employee policies. 12 policy clauses; test-only 10 fixtures / 7 example blocks. |
| `design/evaluation/evidence/adoption/experiments/layout/single/after/ExpenseWorkspace.can` | 33,130 | 266 | Historical variant — Matched layout case: intact expense/employee/rent_catalog owners, ordered >EUR500 distinct finance approval and preserved decision/receipt/reimbursement authority. 14 policy clauses; test-only 12 fixtures / 11 example blocks. |
| `design/evaluation/evidence/adoption/experiments/provider/CanMail.can` | 32,108 | 293 | Historical variant — mailroom: service/delegate/item/handling/dispatch, charge/reconciliation and notice callbacks; original staff/recipient read grants. 8 policy clauses; test-only 5 fixtures / 10 example blocks. |
| `editors/vscode/audit-astra/final-changed-files/draft/CanMember.can` | 58,489 | 605 | Historical variant — member_plans/terms/content: plan/benefit, term/seat/allowance request fences, renewal/payment/access handlers; original owner/manager/editor grants. 21 policy clauses; test-only 13 fixtures / 9 example blocks. |
| `editors/vscode/audit-astra/final-changed-files/draft/CanRent.can` | 121,283 | 1,151 | Historical variant — catalog-UI/reservations/fulfillment/reporting + Workspace: capacity/venue/quote/move, payment/allowance and recovery handlers; original resource/account grants. 30 policy clauses; test-only 3 fixtures / 1 example blocks. |
| `editors/vscode/audit-astra/snapshot/draft/CanInvoice.can` | 57,614 | 587 | Historical variant — invoice/Finance: invoice/lines, payment/credit/refund/reconciliation attempts and document/billing ingress; original finance/customer policies. 16 policy clauses; test-only 6 fixtures / 15 example blocks. |
| `editors/vscode/audit-astra/snapshot/draft/CanMember.can` | 58,582 | 604 | Historical variant — member_plans/terms/content: plan/benefit, term/seat/allowance request fences, renewal/payment/access handlers; original owner/manager/editor grants. 21 policy clauses; test-only 13 fixtures / 9 example blocks. |
| `editors/vscode/audit-astra/snapshot/draft/CanRent.can` | 110,222 | 1,077 | Historical variant — catalog-UI/reservations/fulfillment/reporting + Workspace: capacity/venue/quote/move, payment/allowance and recovery handlers; original resource/account grants. 29 policy clauses; test-only 3 fixtures / 1 example blocks. |
| `draft/CanApprove.can` | 32,502 | 340 | Current draft — approve: documents/submissions, reviewer assignment/decisions and due notices; submitter/coordinator/reviewer grants. 7 policy clauses; test-only 18 fixtures / 15 example blocks. |
| `draft/CanBook.can` | 40,059 | 498 | Current draft — appointments: calendars/windows/types, reservation/replacement attempts, attendance/cancel and cleanup; account/host grants. 11 policy clauses; test-only 8 fixtures / 18 example blocks. |
| `draft/CanCRM.can` | 31,176 | 425 | Current draft — crm: Deals/Activities, retained research intake and linked tours/quotes/Sales; salesperson/location guards. 4 policy clauses; test-only 10 fixtures / 13 example blocks. |
| `draft/CanDiscover.can` | 32,740 | 394 | Current draft — discover: Plans/Runs/source-page attempts, opportunity/evidence/conflict review and promotion; researcher/reviewer/location grants. 8 policy clauses; test-only 11 fixtures / 13 example blocks. |
| `draft/CanEvent.can` | 66,450 | 624 | Current draft — events + invoice: registration/capacity, venue changes, cancellation/refund/settlement and notices; public/staff/attendee projections. 10 policy clauses; test-only 9 fixtures / 25 example blocks. |
| `draft/CanExpense.can` | 46,344 | 503 | Current draft — expense: receipt/claim/decision/reimbursement, reviewer choices, correction and locked historical mapping; claimant/reviewer/finance grants. 10 policy clauses; test-only 21 fixtures / 23 example blocks. |
| `draft/CanGrant.can` | 46,405 | 446 | Current draft — grant: public criteria, private applications/comments, intake/decisions/withdrawal/recovery and award export; coordinator/reviewer grants. 11 policy clauses; test-only 15 fixtures / 15 example blocks. |
| `draft/CanHire.can` | 34,746 | 433 | Current draft — hire + PeopleDevelopment: vacancy closure/retention, candidate/interview scheduling/recovery, feedback/decision/handoff; recruiter/interviewer/HR grants. 8 policy clauses; test-only 4 fixtures / 13 example blocks. |
| `draft/CanInbox.can` | 38,046 | 435 | Current draft — inbox: mailbox/queue grants, budgeted classify/review, authored reply/disposition and uncertain-send reconciliation; admin/staff authority. 11 policy clauses; test-only 21 fixtures / 15 example blocks. |
| `draft/CanInvoice.can` | 101,821 | 1,045 | Current draft — invoice + Finance: invoice/lines, payment/refund attempts/reconciliation, documents, commercial history and locked historical mapping; finance/customer projections. 23 policy clauses; test-only 15 fixtures / 35 example blocks. |
| `draft/CanMail.can` | 43,567 | 423 | Current draft — mailroom: services/delegates/items/handling/dispatch, fee recovery and associated notices; staff/location versus recipient grants. 9 policy clauses; test-only 11 fixtures / 13 example blocks. |
| `draft/CanMaintain.can` | 47,834 | 506 | Current draft — maintain + Facilities: asset/plan/inspection/repair, assignment/verification, cancellation/progress and downtime recovery; manager/technician grants. 12 policy clauses; test-only 12 fixtures / 18 example blocks. |
| `draft/CanMember.can` | 80,482 | 912 | Current draft — member_plans/terms/content: paid terms/seats/allowances, request fences/reversals, renewal/consent/refund/access handlers; distinct owner/manager/editor grants. 21 policy clauses; test-only 16 fixtures / 20 example blocks. |
| `draft/CanPropose.can` | 47,364 | 483 | Current draft — propose: proposal/revision/item evidence, document/recipient decision, quote hold/book/release and deadline recovery; salesperson/recipient grants. 5 policy clauses; test-only 8 fixtures / 20 example blocks. |
| `draft/CanPurchase.can` | 46,446 | 540 | Current draft — purchase + supplier: budgets/orders, additive amendments/increases, receipts/returns/stock recovery, invoice/payable intake; approver/location guards. 14 policy clauses; test-only 11 fixtures / 15 example blocks. |
| `draft/CanReception.can` | 44,461 | 502 | Current draft — reception: visits/host eligibility, membership/access/device reconciliation and physical-key lifecycle; receptionist/access-staff/host grants. 8 policy clauses; test-only 5 fixtures / 11 example blocks. |
| `draft/CanRent.can` | 197,946 | 1,905 | Current draft — CanRent/Workspace: catalog-UI/reservation/fulfillment/report owners, capacity/quote/move fences and recovery, money/allowance fulfillment, history mapping; account/location/finance grants. 36 policy clauses; test-only 17 fixtures / 23 example blocks. |
| `draft/CanShift.can` | 43,864 | 393 | Current draft — shift + StaffScheduling: roster/availability/commitment/duty/swap, connected reserve/stage/release and eligibility handlers; scheduler/employee scope. 12 policy clauses; test-only 14 fixtures / 12 example blocks. |

## Post-merge maintenance: mandatory and incremental

After **every merge**, the person or agent handling that merge must reconcile this plan. This applies to merges through a hosting UI, CLI, squash/rebase workflow or another agent. Maintaining the plan never authorizes implementing its proposals.

1. Read the latest checkpoint above and inspect the actual checkout/instructions/status. Verify the merge's resulting commit. Preserve unrelated work. Review **all accumulated changes since the checkpoint**, including earlier unreconciled merges, not just the most recent PR. Normally inspect `git diff --name-status <checkpoint>..<merge-result>` and the resulting source, plus relevant history. If history was rewritten or the checkpoint is unavailable, reconstruct the delta and record that scope; do not silently substitute an unrelated baseline.
2. Refresh `git ls-files` (including hidden paths and gitlinks). Check additions, removals, renames, assets, generated evidence and submodule-pointer changes. Compare the old inventory with the desired-tree leaves and exception table. Inspect changed files inside their folders, large changed implementations and affected import/export consumers, entrypoints, tests, manifests, generators and build/install/release wiring. Follow impacts beyond changed-path lists when necessary. Unchanged areas need no repeated full audit or builds.
3. Update **together** the selected tree, package ownership/import decisions, decomposition boundaries, caller/build/test obligations, references, size observations and coverage/disposition ledger. Remove implemented proposals and their `+` markers; record their now-current location. Remove superseded proposals and obsolete retirement gates. Preserve inline behavior examples and mark new API/size claims unverified until their implementation evidence exists. Keep the permanent initial full-review baseline separate.
4. Check exact path coverage, destination collisions (including case-insensitive paths and file/directory conflicts), Rust module and TypeScript/Node extension/export naming, active document links and authority boundaries. Record checks actually performed and remaining uncertainty. Run only checks justified by the changed source; documentation bookkeeping needs structural/link checks, not full runtime builds.
5. On complete reconciliation, advance the **latest reconciled source** to the reviewed merge result, date and review scope **even when no structural changes were needed**. Record “reviewed; no structural changes” with the relevant delta. When reconciliation is incomplete, keep the previous checkpoint and list exact remaining paths/consumers/questions plus the required follow-up. A maintenance date may change while the checkpoint stays put; label that partial review clearly.
6. Do not make recursive self-updates. A commit containing only this plan and its contributor/index links is bookkeeping, not a new source-baseline audit. Record source/merge-result commits, not the later commit that saves the checkpoint. If a merge contains source plus bookkeeping, reconcile its source delta once. For a merge containing documentation alone, inspect whether it changes authority, proposed structure or references; if it changes only this plan's routine checkpoint/index prose, acknowledge it without committing another self-referential update. The next substantive merge includes any intervening history in its accumulated delta.

Manual commands are sufficient and usable in a fresh checkout:

```sh
git rev-parse --show-toplevel
git status --short
git log -1 --format='%H %cI %s'
git diff --name-status <previous-checkpoint>..<merge-result>
git ls-files
git ls-files --stage draft
git -C draft ls-files
rg -n 'old/path|old_module|publicSpecifier' compiler packages tests tools .github editors
```

Do not copy placeholder commits into a shell. Resolve checkpoint/merge-result from Git first. Inventory and review do not require the temporary audit scripts or `/tmp` reports used for the initial research. The complete filenames, exception mapping, checks and consultation evidence live in this document. No automation, Git hook or CI job is added.

## Verification, uncertainty and implementation gates

Verified during this documentation task:

- Exact checkout, active AGENTS instructions, Git status, branch/history/source revisions and draft gitlink. Reconciled the initial B1 work, correction commit, external squash merge, required-member contract and twelve-file follow-up through `b52ad877` and its source-identical squash merge `8249342` without changing Git history or source; separately inspected concurrent status/e2e-loader working edits without moving the committed checkpoint to uncommitted content.
- Coverage of **1,897 tracked parent paths** (1,896 blobs plus gitlink) and **148 pinned submodule files**. Document-only reconstruction of the complete tree and exception mapping found no missing current inputs or absent destinations. All tracked folders/hidden files/evidence/build definitions are included; ignored/private inputs are excluded.
- No duplicate destinations after intentional consolidation, case-insensitive collisions, file/directory conflicts, invalid proposed Rust source module names or `foo.rs`/`foo/mod.rs` conflicts. NodeNext `.js` runtime imports versus TS `.ts` test imports, separate CommonJS editor/probe `.cjs`, Cargo target discovery and generated specifier/dist-root dependencies were checked as constraints. Proposed module declarations/exports are not compiled APIs.
- All **16 active local links** in this plan and the **four contributor/index links** resolve. Existing stale links/commands are recorded as gaps; frozen historical references are preserved, not rewritten to today's layout.
- All **115 frozen baseline SHA256 entries** match their captured files. Inspected the three PNG assets and parsed/structured large evidence JSON; no generated advice/measurement/token dump was silently classified as disposable source. Authored request/manifests/grammar JSON remain distinguishable from generated results.
- Three required JEV choice consultations and their full requests/responses/uncertainty are saved below. Documentation diff whitespace, complete fence/placeholder structure and the task's final changed-file scope were checked.

No refactor, manifest/runtime configuration change, install, runtime build/test, commit, merge or push was performed by this task. Runtime test/probe results mentioned in evidence are producer-reported results, not independently rerun certification. The desired APIs/export maps, complete shipping set, final file sizes, behavioral equivalence after splitting and integration performance/safety remain unverified until implementation. Temporary review scripts are unnecessary to use or maintain this plan.

Unresolved decisions: localization differences must be reconciled before sharing values/UI implementation; standard-library generated-handler bindings must use settled producer contracts; the form producer must resolve selector strings into `FormFieldDef` objects and complete dispatcher metadata, with writable-input/default/bound-argument coverage still unverified; custom editor protocol versus the previously proposed standard client is not selected here; Python retirement needs syntax/location parity; source-versus-dist publication/build normalization needs a review of every exported consumer; the current B1 canonical schema/page-context/invocation joins must be closed by their owners. None of these is converted into a promised implementation or performance/safety claim.

## JEV consultation evidence

The difficult package-boundary choice was consulted using `tools/jev.py`, question type `choice`, with three independently worded equivalent contexts, questions and criteria. A preserves useful semantic packages and consolidates duplicated behavior; B groups runtime producers into three domains; C groups runtime producers into one package with subpaths. Each option is assessed against consumers, migration cost, workflows, authority, simplicity and dependency reachability; no option assumes unmeasured performance/safety gains. No extra services/sidecars/IPC/adapters are allowed.

| Request | Selected | Confidence | P(A) | P(B) | P(C) | Model | Input/output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A | 0.75 | 0.84 | 0.16 | 0.00 | jev-1.13.0 | 776 / 38 |
| 2 | A | 0.84 | 0.90 | 0.06 | 0.04 | jev-1.13.0 | 745 / 38 |
| 3 | A | 0.95 | 0.96 | 0.04 | 0.00 | jev-1.13.0 | 783 / 38 |

All three selected A; probability/confidence variation is preserved rather than presented as certainty. There was no choice disagreement to investigate. Later source review further identified production imports reaching Node-only service test harnesses, reinforcing the need to fix ownership and transitive imports instead of relying on package count. The initial sandboxed connection attempt failed before a result; network-authorized calls used the same first request and two fresh variants, with no automatic caller retries. Advice does not decide unresolved localization semantics or authorize the refactor.

<details>
<summary>Full request and response 1</summary>

```json
{
  "request": {
    "state": "Canlang checkout 99195148 has 12 TypeScript workspaces, one Rust compiler crate and Python research tools. Root Bun installs packages/* once; root builds contracts/cloudflare/testkit and values join, while producer-specific TS builds and Node test runners remain. values supplies stdlib, compiler catalog JSON and conformance; ui/identity are consumed by interfaces and workerd tests. Cloudflare CLI hosts emitted JS using state, interfaces, identity and ui; Rust compiles and communicates through existing artifact/catalog and CLI contracts. state, work, files and services represent storage/invocation, durable work, uploads and provider bindings; contracts is shared authority-neutral protocol; testkit is tooling. stdlib currently assembles values only. Source duplicates exist in values vs ui ICU/locale formatting, forms vs controls field rendering, provider adapters validation owned by mail, state D1/DO codec/predicate helpers and testkit vs services scenario validation (services version depends on Node Buffer). No performance, safety, release or install benefit of merging or adding another language port was measured. Historical lanes explain inconsistent build/export shapes, but ownership/authority responsibilities are real. Small apps remain .can; independent drafts gitlink and frozen evidence remain. Compare effort, cognitive load, compatibility, full workflows and dependency/runtime reachability fairly; services/sidecars/IPC/adapters solely for language boundaries are excluded. This is documentation only; a grouped-package migration may disrupt public imports, compiler runtime specifiers, artifact loader, pack list and conformance fixtures.",
    "questions": {
      "layout": {
        "type": "choice",
        "instructions": "Which package layout is best justified for the deferred desired tree by these verified consumers and ownership constraints?",
        "criteria": {
          "A": "Keep current semantic package owners, consolidate duplicated implementations into their existing neutral owners, and align build/install/export wiring at a later implementation step; split private responsibilities within packages.",
          "B": "Group runtime producer workspaces into three packages (pure values; state/work/files/services runtime; identity/interfaces/ui presentation), retain contracts/platform/testkit tooling, and move tests and import/build/pack callers together.",
          "C": "Consolidate runtime producers into one runtime package with named subdirectories/subpath exports, retain contracts/platform/testkit tooling, and migrate all consumers and build/pack wiring together."
        }
      }
    },
    "model": "jev-latest"
  },
  "response": {
    "model": "jev-1.13.0",
    "answers": {
      "layout": {
        "type": "choice",
        "choice": "A",
        "confidence": 0.75,
        "probabilities": {
          "A": 0.84,
          "B": 0.16,
          "C": 0.0
        }
      }
    },
    "usage": {
      "input_tokens": 776,
      "output_tokens": 38
    }
  }
}
```

</details>

<details>
<summary>Full request and response 2</summary>

```json
{
  "request": {
    "state": "At revision 99195148 the Canlang source contains a Rust compilation crate, Python utilities, and twelve TS packages installed by a single root Bun workspace. Root checking/emission covers the integration owners plus values, and the remaining semantic producers still have individual checking/testing commands and divergent source-versus-dist interfaces. Real consumers include the values stdlib/catalog/conformance join, interfaces consuming authentication and UI, browser tests embedding their dist trees, and platform loading compiler artifacts into a worker with invocation/storage and interface dependencies. The responsibilities are established: authority-neutral contracts, pure values, owner-local state transactions, durable work, files, external providers, authentication, protocol interfaces, presentation, deployment/local-host tooling, and test runner tooling. stdlib only wraps values at present. Some algorithms are duplicated: UI and values localization, overlapping forms/control primitives, general provider-result checking located in mail, storage SQL/row helpers across D1 and DO, and playback validation repeated to avoid Node Buffer in Workers. Build divergence comes from lane history. The current artifacts and CLI already bridge Rust/JS; extra processes, IPC and language-driven wrappers are outside scope. No measurements establish faster/safer execution or cheaper installation from reducing package count. Source layout work is postponed and must keep permissions, evaluation order, fixture semantics, .can ownership, independent draft repository and frozen audit history intact. Repackaging affects package specifiers/exports, emitted imports, loader trees, manifests, release packs and tests.",
    "questions": {
      "layout": {
        "type": "choice",
        "instructions": "Given the documented dependency graph and migration costs, select the most supportable target organization for this living research plan.",
        "criteria": {
          "A": "Preserve the existing responsibility-based workspaces; remove duplicate algorithm ownership at existing neutral producers and later make their build/export integration consistent, with internal decomposition as needed.",
          "B": "Adopt three producer groups for values, durable execution plus providers/files, and authentication plus interfaces/rendering; retain shared protocols and platform/test tools separately, updating every dependent path as a unit.",
          "C": "Use one runtime workspace with responsibility folders and explicit exported subpaths, while keeping shared contracts and platform/testing tools apart; change all downstream imports and release/build instructions in the migration."
        }
      }
    },
    "model": "jev-latest"
  },
  "response": {
    "model": "jev-1.13.0",
    "answers": {
      "layout": {
        "type": "choice",
        "choice": "A",
        "confidence": 0.84,
        "probabilities": {
          "B": 0.06,
          "C": 0.04,
          "A": 0.9
        }
      }
    },
    "usage": {
      "input_tokens": 745,
      "output_tokens": 38
    }
  }
}
```

</details>

<details>
<summary>Full request and response 3</summary>

```json
{
  "request": {
    "state": "Evidence from Canlang commit 99195148: twelve JavaScript/TypeScript workspaces are installed together with Bun, alongside a single Rust compiler and Python syntax/evaluation tools. Only the integration packages and the values join participate in the root build; producers use separate TS build/typecheck and Node tests, sometimes exporting source rather than built files. These packages are not unused mirrors: values feeds standard functions, a Rust-consumed JSON catalog and fixture comparisons; UI and identity feed interfaces and actual local worker journeys; cloudflare assembles emitted handlers with state and interface/auth/rendering pieces. Shared contracts, values, owner state, durable jobs, files, provider clients, identity, interfaces, UI, stdlib, platform and testkit have documented owners. The thin stdlib is values-only for now. The strongest repeated logic appears in ICU/locale behavior, form/control field representations, completion checks incorrectly housed in mail, common SQL and codecs in D1/DO, and scenario validation duplicated for Worker portability because the services implementation imports node:buffer. An earlier lane structure caused fragmented install/build/export conventions. Merging might simplify package integration, but published import stability, producer testing, artifact loading, generated runtime imports and pack definitions are affected and benefits are not measured. We must conserve product and storage authority distinctions, app composition in Can, draft gitlink ownership and historical evidence. No new service, sidecar, IPC boundary or language-accommodation adapter is acceptable. Compare the three options on supported workflows, maintenance/change burden, author simplicity and token-efficient navigation without assuming speed/safety gains.",
    "questions": {
      "layout": {
        "type": "choice",
        "instructions": "Which deferred tree choice follows most closely from this evidence while keeping the change scope proportionate?",
        "criteria": {
          "A": "Leave useful package responsibility boundaries in place, share the known duplicate logic through its natural existing owner, standardize producer wiring later, and partition large files by actual private responsibilities.",
          "B": "Collapse producer boundaries into a pure-values group, a state/work/files/providers group and an identity/interfaces/UI group, preserving separate contracts and platform/testkit and migrating the affected consumers/tests/builds.",
          "C": "Place all production runtime domains in one package with internal directories and public subpath modules, leaving contracts and platform/testkit separate and adapting emitted imports, tests, loaders and release wiring."
        }
      }
    },
    "model": "jev-latest"
  },
  "response": {
    "model": "jev-1.13.0",
    "answers": {
      "layout": {
        "type": "choice",
        "choice": "A",
        "confidence": 0.95,
        "probabilities": {
          "C": 0.0,
          "A": 0.96,
          "B": 0.04
        }
      }
    },
    "usage": {
      "input_tokens": 783,
      "output_tokens": 38
    }
  }
}
```

</details>
