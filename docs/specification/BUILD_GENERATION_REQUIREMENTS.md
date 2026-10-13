# Build time AI generation requirements

Can must let an AI coding agent describe custom application behavior and presentation in `.can`, generate the implementation through a selected coding tool, and maintain the resulting JavaScript and CSS as saved, editable code. Generation must preserve working implementation and allow one region to change independently of another.

Status: finalized and accepted by the human, 13 October 2026, including the row-bound view scope and cooperative write leases. The generation engine is not implemented. The broader [language requirements](REQUIREMENTS.md) continue to apply.

The [accepted choices](../../design/proposals/build-generation/choices.md) resolve all 25 D1–D6 subchoices. The [implementation plan](../../design/proposals/build-generation/implementation-plan.md) is the single current execution view; its tasks are planned, not started.

The [grouped application drafts](../../draft/GENERATION_DRAFTS.md) rehearse these source forms and saved-file organization with explicitly handwritten witnesses. They do not establish implemented grammar, generator metadata APIs or target qualification.

## Scope

One generation lifecycle serves four declaration categories. Their generated outputs and consumers differ; their selection, persistence, failure and refinement rules are shared.

| Category | Required outcome | Generated implementation | Defining owner |
| --- | --- | --- | --- |
| Given local modifiers | Describe local reusable words that add declared facts, defaults, constraints or custom behavior to explicitly selected declarations | Compiler-visible schema and rule contracts as needed, plus JavaScript for custom runtime behavior | Owning Given declaration and target model or field; supporting effects retain their canonical operation or hook |
| When implementations | Describe an implementation behind an existing operation or handler contract | JavaScript implementing its declared inputs, results, guards and effects | Owning scenario or handler, including its permission or verified trigger |
| Then styles | Describe appearance for ordinary components and custom reusable components | Scoped CSS | Each inline or optionally named style block |
| Then custom components | Describe reusable rendering and supported interaction behind declared inputs and action bindings | Server renderer or template, CSS as needed, and separate browser JavaScript when needed | Owning view or component declaration and its checked use sites |

Server implementations, including server rendering, target workerd. Browser interaction code executes in the browser; CSS styles browser output. A coding CLI executes during generation preparation, not inside the deployed application.

Custom components extend same-module `view Name(row:Model)` / `show Name {row=expression}`: one required nonnullable stored-model row, evaluated once, with checked canonical form/action bindings. Arbitrary props, slots, nested `show`, caller capture and cross-package exports are outside the initial scope. Generated rendering/assets/control bindings remain implementation work beyond the existing source-expansion pilot.

## Functional requirements

### BGEN 01 Source intent and concise defaults

`.can` remains the owner of app identity, composition, declaration contracts, authorization and generation intent. Natural-language generation instructions must be distinguishable from ordinary `#` description metadata and `##` comments, which retain their existing meanings.

Then styling must support both inline and named blocks. A name is optional, and omitting the agent selects the shared `frontend` profile without requiring `agent=frontend` on every block. Optional logical profile overrides must be supported without repeating provider configuration. Given local words must apply only where explicitly used and must not redefine built-in keywords or language defaults.

The accepted carriers are named `trait Name "prompt"`, direct local-word applications and inline `trait "prompt"` in Given; `do "prompt"` as an exclusive alternative to an ordinary implementation suite in When; and inline/named `style "prompt"` / `style Name "prompt"` plus `view Name(row:Model) "prompt"` in Then. Optional `agent=profile` references a tooling recipe. Preserve signatures, permissions, guards and independently authored examples; prompted and ordinary operation bodies cannot be mixed.

The feature must not require verbatim CSS or JavaScript embedded in `.can`. New style blocks carry prompts and optional profiles, without a new typed CSS/token map. Existing checked component options and editing saved implementation files remain supported.

### BGEN 02 Complete generation targets

All four categories in the scope table must participate in the shared lifecycle. Style blocks must work inside reusable custom component definitions as well as page content. Definition-owned component styles are generated once for the definition, rather than invoking an AI for each rendered instance.

Generated declarations and implementation must expose the fields, interfaces, actions and effects needed by compiler analysis and runtime integration. A successful coding-tool response alone cannot create an invisible schema, operation or privileged callback.

Named traits are definition-owned units: applications instantiate compiler-visible contributions in source order without additional AI calls. Inline traits belong to their target. Model traits may contribute fields and supported model invariants/hooks; field traits may contribute compatible constraints/defaults only to that field. Reject incompatible target kinds/types, built-in redefinition, duplicate contributions and contradictory defaults. Existing canonical operation/hook and migration owners retain their duties.

A prompted row-bound view may declare checked canonical controls and definition-owned styles as children. Its renderer arranges those bindings using presentation helpers; optional browser code enhances them through canonical submission helpers. No arbitrary executable presentation children or generated permission grants are admitted.

### BGEN 03 Coding tools and models

Provide CLI-backed generation adapters for Codex, Muse Code, Claude Code and OpenCode when their supported executable, authentication and model are available. Each adapter must support noninteractive generation, explicit model selection, completion or failure reporting, and bounded execution.

The CLI runner and the model are separate controls. Record the requested model and the actual provider/model reported by the tool when available; report unavailable resolved identity honestly. Unsupported models or capabilities produce actionable errors. Do not silently substitute another runner, model or permission mode.

The initial implementation uses installed CLIs and their native authentication. A direct API adapter may be added later through the same generation contract; it is not required for the initial feature.

### BGEN 04 Shared generation configuration

Runner, model and bounded execution preferences must be reusable at project scope through `can.gen.toml`, version 1, with shared generation settings, optional named profiles and explicit per-run overrides. `.can` may reference a logical profile but must not need repeated tool binaries or model recipes beside every prompt.

Resolve configuration from the supplied project root and report the effective configuration. Machine-specific settings and authentication remain separate from committed app intent. Generation configuration must not become a source registry, dependency manifest, duplicated app definition or authorization source. Credentials must not appear in generated code, browser assets or committed metadata.

Profiles require complete runner/model pairs; optional finite limits reuse shared limits without an inheritance graph. Then selects the reserved `frontend` recipe when configured, otherwise shared; Given/When select shared. Run profile selection overrides the owning declaration's optional profile, then the category default applies. Unknown explicit profiles diagnose. No backend role is required.

An explicit `--settings FILE` replaces the root file; explicit run values override the selected recipe. Do not search ambient user/local/ancestor configuration. A runner override requires an explicit compatible model. Report values and origins. Native adapter options remain specific to their recipe and capabilities. Changing tool or model affects future attempts; it does not replace compatible existing code or invoke generation during an ordinary build.

### BGEN 05 Saved outputs and ordinary builds

Persist generated implementation and the minimal source association and interface metadata needed to build it. Track current implementation so a clean checkout can build the saved code without the generation CLI, its login or a model call.

Current files live under tracked `can.generated/<opaque-unit-id>/`: `unit.json`, JavaScript/CSS, compiler-visible `contributions.can` and owned assets only where needed. ABI version 1 and truthful provenance accompany the association. Candidates, execution records, journals and leases live under ignored `.can/gen/`. Generation never commits to Git implicitly.

Normal build, check and bundle operations use current saved bytes, including compatible direct edits. They must not regenerate missing or stale implementation silently. Return the concrete affected unit and a generation or reconciliation action. Explicit generation preparation can be composed with a build, but must be identifiable as generation.

The ordinary compiler continues to derive schemas, HTTP/MCP/form interfaces, resource requirements, migration plans and application bundles from owning declarations and accepted implementation. Do not add a second authored dependency or interface manifest.

### BGEN 06 Stable independently selectable units

Each style block, local modifier implementation, prompted operation and custom component implementation has a discoverable generation identity and owned output group. Identity must be separate from prompt freshness and transient source offsets or ordinals. Preserve associations across unrelated edits and formatting; ambiguous moves, copies or renames must diagnose rather than attach the wrong saved implementation.

Named and inline units must both be discoverable through structured inspection, with owner, source location, kind, target and concrete current/candidate paths. Inline units must not require editor selection or an author-written name. Copied units cannot accidentally share mutable implementation ownership.

Allocate opaque IDs through tracked minimal association records. Match only uniquely supported owner/kind/label/normalized-structure evidence; a prompt-only edit may preserve an unchanged unique non-prompt anchor. Do not infer association by nearest offset, prompt similarity or a sole unmatched pair. Explicit `bind` supplies a current source location/revision and an existing ID or `new=true`; copies receive new IDs.

### BGEN 07 Selective changes preserve other work

Retry, refine, fresh generation, cancellation, reset, adoption and acceptance require an unambiguous selected unit or attempt. A missing target is an error, never an instruction to operate on all units. Explicit batch operations must enumerate their targets; selection cannot widen silently to the whole app, every failure or a dependency closure.

Generation and refinement write only the selected candidate group. Acceptance replaces only its matching current group. Other implementation and metadata remain intact. Relevant consumers may need checks, but cannot be regenerated automatically. Report any required outside-scope change and leave that implementation untouched.

A local style change must remain within its declared selectors and hooks; it cannot modify global theme/shared assets as a side effect. Existing semantic elements expose ownership/root/part hooks. A parent can style a child-scope host's placement, size and inherited inputs, but cannot traverse into its interior. Ordinary inheritance/theme/geometry dependencies remain explicit; selector isolation does not promise pixel isolation. Reusable trait/component definitions affect their applications/uses; inspection walks the checked graph and exposes source sites/owners without a new persistent use index. Two regions within one style block are one unit; independent control requires separate scopes.

Parse and enforce ownership for generated and directly edited CSS, including supported nesting and guards on every selector compound. Support local selectors, conditions and namespaced keyframes/custom properties. Initially reject global escapes, unsupported relational selectors, `@import`, `@font-face`, remote asset URLs and traversal. Local styles can read shared theme variables but cannot redefine them; use existing theme/system fonts and owned assets.

### BGEN 08 Direct implementation access

The AI agent authoring `.can` must be able to inspect and directly edit the associated tracked JavaScript and CSS under ordinary workspace permissions. Generated files are primary implementation inputs, not disposable build output or inaccessible internal blobs.

Source-compatible direct edits do not require another AI call or an additional candidate ceremony. Builds use the current files. If a direct edit changes lasting intent or a declaration contract, the authoring agent must be able to update the source and reconcile compatibility without being forced to regenerate through an AI.

Agents/tools obtain brief `edit.begin` / `edit.end` write leases for exact current-unit/source paths, then use ordinary workspace file edits. This is coordination, not a permission prompt or candidate approval. Capture, adoption, promotion and build readers honor the same protocol. Compatible byte edits alone do not require `adopt`.

### BGEN 09 Distinct generation and refinement operations

Refine starts from current implementation, including direct edits, together with current source contracts and a supplied instruction. It produces a separate candidate.

Fresh generation deliberately requests a new implementation from source intent rather than treating the existing implementation as its design baseline. It still retains current files until replacement is accepted.

Retry repeats a selected failed attempt against the same captured inputs and effective recipe. Changed instructions, files or recipe require a new capture. Resume or recovery continues a specific recorded session/request only when the adapter supports it and the capture remains applicable. These operations must not be conflated.

### BGEN 10 Consistent candidate promotion

Acceptance is callable by the authoring agent. No dashboard, graphical preview, editor picker or human confirmation is required. A composed generate/refine, validate and accept operation must preserve the same checks as separate operations.

Before promotion, obtain the relevant cooperative leases and compare source/contracts/target inputs, current implementation bytes and attempt state with the capture. An intervening participating edit, source change, reset or newer acceptance prevents replacement. Retain the candidate and report the conflict; never overwrite the newer participating work. This guarantee covers participating writers/readers. An arbitrary editor ignoring leases may race the final comparison; byte checks and a journal do not provide filesystem compare-and-swap protection. Observed unexpected changes still refuse destructive promotion/recovery.

Promote the selected unit with one journal containing old/replacement groups and recovery state, using atomic per-file replacement under the leases. Builds refuse unresolved journals, snapshot their consumed inputs under read leases, and compile that immutable snapshot. Failures/interruption cannot expose a partially accepted group to those readers. Before commit, recovery restores the old group; after commit, it finishes the new group. Recovery is idempotent, refuses unexpected bytes and retains both groups for reconciliation. Use supported durable file/rename operations and diagnose unsupported guarantees; this is a coordination protocol, not a filesystem transaction.

Retain one previous current group including direct edits as an explicit rollback target; further available history can use source control. Long-running generation holds no write lease. Leases never expire or get stolen automatically: interrupted-lease recovery requires confirmation that its writer has stopped.

### BGEN 11 Runtime and language contracts

Generated server JavaScript must be compatible with the selected workerd version/configuration, supported APIs and declared bindings. Generated browser code has its own target and receives only admitted presentation data and canonical action bindings.

Use compiler-owned wrappers and ABI version 1 for declared `run`, pure synchronous `defaultValue`/`check`, `render` and optional browser `mount` roles. Source-owned saved declaration contributions pass normal compiler analysis before dependent JS; do not execute a module to discover schema/authority. Can retains authority, ownership, field grants, input/result validation, exact value representations, guards, versions, transaction commit, failure/replay and evaluation order. Generated code cannot establish separate storage authority or treat presentation visibility as permission.

Expose narrow compiler-bound sequential async effects through canonical producers, never raw HandlerContext/store/registry/principal mutation/commit. Validate arguments before suspension; permit one active effect, reject overlap/pending return/late calls and retain canonical failure even if JS catches it. Reads observe preceding staged writes; validate/project the final result before the existing single fenced commit. Failure/conflict preserves business-state rollback; canonical receipt bookkeeping retains its existing semantics. Replay does not rerun generated behavior. Exact codecs and admitted record associations remain owned by the existing packages.

The initial execution model is trusted application/workspace JavaScript, with admitted compiler producer and unit-local imports. Undeclared storage/network effects and privileged imports violate that application contract. Import/target checks and a narrow interface do not prove arbitrary JS purity or hostile-code containment; no separate sandbox/interpreter is required.

The interface must make generated Given fields and rules, When implementations and component bindings inspectable and usable by their normal consumers. Existing Can analysis does not typecheck arbitrary JavaScript or prove its semantics; the new integration must supply its own finite contract and checks.

### BGEN 12 Compatibility and behavioral validation

Validate generated implementation against its declared interface and actual target before accepting it. JavaScript syntax, successful imports, a coding-tool success message or Node execution alone do not establish workerd compatibility or correct behavior.

Use relevant existing examples and runtime checks for success, refusal, failure and recovery. Expected business behavior must remain independently authored rather than inferred from implementation generation. Reuse unchanged results and shared runtime checks; do not create a new proof framework or repeat unrelated suites.

Preserve existing application interaction contracts, including canonical forms/actions, authorized data, validation feedback and focus behavior. Agent-first generation tooling does not change those app contracts. Accepting changed stored schemas still follows the existing schema evolution/migration workflow; generation does not itself migrate deployed records.

### BGEN 13 Truthful provenance and freshness

Record the owning unit, relevant captured inputs, target configuration, effective generator recipe/CLI version and the historical output actually produced. Keep this record minimal and distinct from current edited bytes.

Mark later direct edits as modified since generation without crediting them to the original generator or inventing an editor identity. Source/contract/target changes must expose the exact compatibility issue; provide deterministic validation/adoption for manually reconciled implementation. Unrelated source changes, live business data and generator preference changes alone do not invalidate compatible code.

Maps identify executable current saved JavaScript; a separate unit/span link identifies the owning `.can` intent. Do not invent executable statements inside the natural-language prompt.

### BGEN 14 Agent-facing controls

Provide `can gen` as a version 1 JSON request dispatcher through stdin or `--request FILE`, with one final JSON result and optional JSONL progress ending in that envelope. Document schemas, deterministic error/exit semantics and concrete next actions. Large instructions use exactly one selected text/file/stdin carrier. Invoke coding tools with structured arguments rather than concatenated shell strings.

Existing-unit mutations require explicit unit IDs; attempt operations also require attempt IDs. Association creation/reconciliation uses BGEN 06's explicit source selector. `generate` chooses `prepare` or `fresh`; `accept=true` composes generation/refinement, validation and conditional promotion without weakening checks. Repeated request IDs with identical inputs recover/return the same operation, never duplicate provider work; different inputs under that ID conflict. Explicit batches return per-unit outcomes without promising batch atomicity.

Results carry version/request/operation/selected IDs, state, paths, effective recipe, phase/validation summaries, structured errors and next actions. Distinguish `candidate` from `accepted`; requested acceptance cannot succeed after candidate production alone. Exit codes: 0 requested outcome succeeded; 2 invalid request/config/selection; 3 conflict/held lease; 4 validation failure; 5 runner failure; 6 unknown completion.

The required capabilities are:

| Capability | Observable behavior |
| --- | --- |
| Provider check | Reports adapter availability, supported controls and actionable authentication/model issues without coding generation |
| Status and inspection | Returns unit IDs, source association, paths, targets, freshness, direct-edit state, recipe and attempt state |
| Bind | Reconciles one explicit source location/revision with an existing ID or allocates a new independent ID |
| Generate and fresh generation | Produces candidates for explicitly selected units |
| Retry and supported session recovery | Handles one captured failed or recoverable attempt without changing other units |
| Refine | Uses current implementation and a new instruction as its baseline |
| Diff and optional preview | Returns machine-consumable differences and optional rendered artifacts |
| Validate and adopt | Checks candidates or directly repaired files and reconciles their current source association |
| Accept | Conditionally promotes only the selected compatible candidate group |
| Cancel | Stops execution best-effort and prevents late results from promotion |
| Reset | Discards selected pending work while preserving current files and direct edits |
| Rollback | Restores an explicitly selected historical revision with compatibility checking |
| Edit leases and recovery | Coordinates exact editable unit/source paths; releases a token or recovers an interrupted lease only after its writer is confirmed stopped |
| Ordinary build/check | Consumes current saved implementation with zero AI calls |

The agent must be able to complete discovery, generation/refinement, checks, acceptance and build without a person using a generation UI. Optional editor and graphical integrations are not prerequisites.

### BGEN 15 Finite failure and recovery

Execution must have finite attempt and time limits, cancellation and structured progress/failure state. Do not create indefinite retry loops. Additional turn/spend/permission controls are supported only when the adapter can enforce them; unsupported requested controls diagnose.

Defaults are one provider execution and 600 seconds per command. Larger finite settings are explicit. Bounds apply to each requested execution; a later explicitly requested retry is still available. Only selected known-failed work can repeat automatically within an explicit bound; unknown completion cannot. Reset/cancel/new acceptance advance the attempt fence before releasing coordination.

Missing tools/authentication, unsupported models, permission needs, validation failure, cancellation and conflicts retain current code and unrelated units. Reset removes pending attempt/candidate state, not current implementation. Rollback is the distinct operation for restoring previous files.

A timeout or disconnected process does not prove provider work stopped. Report an unknown outcome distinctly, recover by a specific request/session identity when possible, and make possible duplicate work/cost visible before an explicit new attempt. Late or superseded results remain candidates and cannot promote themselves. Honor the configured CLI/task permissions instead of silently disabling them for headless operation.

## Acceptance scenarios

These are finite conformance outcomes for the future implementation, not claims of executed tests or additional implementation tasks. Each refers to the requirements above.

| Scenario | Required observation | Requirements |
| --- | --- | --- |
| Four generation categories | Generate named/inline traits, a prompted operation, a same-module row-bound view with canonical controls and styles inside it; each has the correct contract and runtime target, and unsupported component inputs refuse | BGEN 01, 02, 11 |
| CLI and model choice | Select each supported installed/authenticated runner and an available model; report effective identity and reject unsupported selection without changing current files | BGEN 03, 04, 13, 15 |
| Saved build | Generate once, then rebuild from saved files and a clean checkout without generation credentials or a coding-model call | BGEN 05 |
| Keep one style and change another | Create two independent style scopes; refine/fresh/retry only one. The other files and its owned style remain unchanged, and the selected current style remains until acceptance | BGEN 06, 07, 09, 10 |
| Inline scope identity | Format or edit unrelated source without losing the saved inline association; copy/ambiguous relocation cannot reuse the wrong mutable output silently | BGEN 06 |
| Direct refinement | Inspect paths, acquire an edit lease, edit current JS/CSS normally, release it and rebuild without AI while retaining truthful original provenance | BGEN 08, 13, 14 |
| Concurrent participating edit | Edit current files/source under a lease while a candidate is running; its completion cannot overwrite newer work, and builders snapshot no mixed accepted group | BGEN 10, 15 |
| Interrupted promotion and lease | Interrupt each relevant replacement phase; builders refuse unresolved groups, recovery yields the old/new complete group or a retained conflict, and interrupted leases are never stolen automatically | BGEN 10, 15 |
| Request replay | Resend identical request IDs without a second provider launch; changed input under the same ID conflicts, and unknown completion is recoverable or explicitly acknowledged before new work | BGEN 14, 15 |
| Reset and unknown completion | Reset/cancel selected pending work; current/direct-edited and unselected code remain intact, and late completion cannot promote | BGEN 07, 15 |
| Target and authority checks | Exercise relevant generated behavior in workerd/browser and preserve typed inputs, canonical permissions, conflicts and failure rollback through the defined interface | BGEN 11, 12 |
| Contract change and agent-only recovery | Expose source incompatibility, repair/refine and validate/adopt selected files, then accept/build through structured commands without mandatory human UI | BGEN 08, 12, 13, 14 |

## Accepted decisions

The human adopts all 25 choices in the [accepted design record](../../design/proposals/build-generation/choices.md), including row-bound views and participating write leases. D1–D6 are closed at that scope. The implementation plan defines the remaining source changes and exact producer/consumer handoffs; it does not reopen these choices or imply a working generator.

| Decision | Accepted resolution |
| --- | --- |
| D1 | Local `trait` words and inline traits; prompted `do`; same-module row-bound generated `view` with canonical controls; prompt-only styles |
| D2 | Root `can.gen.toml`, complete runner/model profile pairs, shared defaults for Given/When and implicit frontend for Then; explicit settings/run overrides and native adapter controls |
| D3 | Opaque IDs in tracked association records; editable current files under `can.generated/<unit-id>/`; explicit reconciliation of ambiguous association |
| D4 | Compiler-checked generated contributions, trusted application JS, compiler-owned wrappers and narrow sequential canonical effects; exact values, truthful maps and finite actual-target checks |
| D5 | Existing-element ownership/part hooks, scoped selectors with ordinary inheritance and explicit child-host boundaries; checked-use graph inspection |
| D6 | Versioned JSON dispatcher, explicit unit/attempt selectors and `accept=true`; brief writer leases, one selected-unit promotion journal and snapshotting build readers |

### Consultation history

All six groups were consulted on 13 October 2026 through three independently worded requests each: 18 requests covering 25 subchoices and returning 75 judgments. The [consultation summary](../../design/jev/build-generation-decisions-20261013/summary.md) records the complete scope, probabilities, confidence, source-based disagreement investigation and original requests/responses.

The consultation consistently favored five concrete alternatives, left two subchoices open and split on 18. The human subsequently adopted the concrete design above, including explicit trust/inheritance/concurrency boundaries. Advice remains historical evidence; adoption is the human's decision, not a claim of JEV consensus or implementation qualification.

## Initial exclusions

Direct API generation adapters, mandatory human generation dashboards/review flows, automatic model fallback, unbounded retries, implicit app-wide regeneration and automatic deployment are not required. Arbitrary component props, slots, nested show, caller capture and cross-package exports; hostile-JS isolation; uncooperative-writer CAS; global CSS/font/import generation; and new typed style maps are outside the initial scope. Existing SaaS, authority and migration constraints remain effective.

The [structured design record](../../design/proposals/build-generation/proposal.json) and [decision history](DECISIONS.md) retain rationale and alternatives. This file owns the feature's required observable outcomes; older drafts do not independently expand its scope.
