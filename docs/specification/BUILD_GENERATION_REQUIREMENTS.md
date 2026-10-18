# Build time AI generation requirements

Can must let an AI coding agent describe custom application behavior and presentation in `.can`, generate the implementation through a selected coding tool, and maintain the resulting JavaScript and CSS as saved, editable code. Generation must preserve working implementation. Manual retry freshly regenerates every generation prompt in the active application scope, including previously successful or preferred styles; selective direct editing remains supported.

Status: required outcomes accepted by the human, 13 October 2026, including named and inline model/field trait prompts, distinct named standalone Given keywords with novel implicit semantics (no inline keyword prompts), ordinary authored When bodies, row-bound views, cooperative write leases, reusable named styles and static `$"..."` generation literals. Build-time generators must submit content through a custom MCP server; its host owns placement and direct generator writes are enforced as unavailable. Codex has selected and frozen D1/D4/D6 v1 in the [implementation contract](../design/proposals/build-generation/implementation-contract.md) under explicit human authorization to implement through Muse. These selected interfaces are not claims that the human personally chose every spelling or that the generation engine is implemented or qualified. The broader [language requirements](REQUIREMENTS.md) continue to apply.

The [choice record](../design/proposals/build-generation/choices.md) records unaffected accepted choices, superseded historical assumptions and the Codex-selected v1 interfaces. The [implementation contract](../design/proposals/build-generation/implementation-contract.md) supplies the frozen D1/D4/D6 handoff; the [implementation plan](../design/proposals/build-generation/implementation-plan.md) remains the single current execution view. A demonstrated contract gap requires an explicit recorded handoff, without narrowing accepted outcomes.

The [grouped application drafts](../../draft/GENERATION_DRAFTS.md) remain an earlier rehearsal with explicitly handwritten witnesses and older wrapper-style syntax. They have not been rewritten to this contract and do not establish implemented grammar, generator APIs or target qualification.

## Scope

One generation lifecycle serves three declaration categories. Their generated outputs and consumers differ; their persistence, failure and refinement rules are shared. A logical generation unit associates source intent with saved outputs; it does not prescribe one runner job or model call per prompt. Manual retry includes all categories in the active app/build dependency closure.

| Category | Required outcome | Generated implementation | Defining owner |
| --- | --- | --- | --- |
| Given extensions | Support reusable named model/field traits, one-off inline model/field traits, and distinct named custom keywords defining new standalone Given declarations with their own targets, arguments and implicit semantics, including behavior current `.can` cannot express; no inline keyword prompts | Saved JavaScript, checked trait contributions and compiler-visible extension contracts as needed | Named trait/custom-keyword definition or attached inline trait and checked applications; integration retains canonical ownership, authority, storage, transaction and replay enforcement |
| Then styles | Describe appearance for ordinary components and custom reusable components | Scoped CSS | Top-level named style definition or component-attached inline prompt; named attachments share the definition |
| Then custom components | Describe reusable rendering and supported interaction behind declared inputs and action bindings | Server renderer or template, CSS as needed, and separate browser JavaScript when needed | Owning view or component declaration and its checked use sites |

Server implementations, including server rendering, target workerd. Browser interaction code executes in the browser; CSS styles browser output. A coding CLI executes during generation preparation, not inside the deployed application.

Custom components extend same-module `view Name(row:Model)` / `show Name {row=expression}`: one required nonnullable stored-model row, evaluated once, with checked canonical form/action bindings. Arbitrary props, slots, nested `show`, caller capture and cross-package exports are outside the initial scope. Saved renderer, asset and control-binding delivery and qualification are recorded in the existing implementation plan; source expansion alone does not establish those outcomes.

## Functional requirements

### BGEN 01 Source intent and concise defaults

`.can` remains the owner of app identity, composition, declaration contracts, authorization and generation intent. Natural-language generation instructions must be distinguishable from ordinary `#` description metadata and `##` comments, which retain their existing meanings.

Then styling must support reusable named definitions, named applications and inline one-off attachments. Omitting the agent on a generation unit selects the shared `frontend` profile without requiring `agent=frontend` on every definition or inline attachment. Optional logical profile overrides must be supported without repeating provider configuration. Given traits and named custom keywords must apply only where explicitly used and must leave ordinary built-in keywords and language defaults unchanged. `policy`, `unique`, `invariant` and `lock` are examples of built-in words carrying implicit behavior; they illustrate statement-level implicit declarations a new named custom keyword may supply, not prompt replacement targets. The required outcome includes genuinely new implicit semantics unavailable in current Can, not merely composition or relabeling of existing expressible code.

Every generation slot requires a static `$"prompt"` literal. Given supports reusable `trait Name $"prompt"`, attached one-off `trait $"prompt"`, and distinct `keyword Name(signature) [agent=profile] $"prompt"` definitions. Keyword applications are standalone `Name argument=value ...` statements with named required compile-time arguments; duplicate/missing/unknown arguments diagnose. Collect definitions before resolving applications so missing saved implementations remain discoverable. Initial reference kinds are `model`, dependent `field(target,type)` and `operation`; ordinary scalar/enum and array types carry checked constants. The compiler-owner reference-kind registry remains extensible through concrete owner integration. References expose metadata, never runtime row access or authority; no executable Given bindings, positional/default guessing, built-in redefinition, anonymous keyword definition or prompt on a keyword application is admitted. Trait contribution/reuse cannot meet novel standalone-keyword acceptance. Then supports only one `style` statement: top-level `style Name $"prompt"`, which names a reusable prompt. Every component instead carries its own style as one attached `$"prompt"` or `$Name` suffix, and a view header carries its renderer prompt first plus that same optional style suffix for its root: `view Name(row:Model) $"renderer prompt" $"style prompt"` or `... $Name`. No inline or wrapper `style` statement exists. `$` is adjacent to the JSON string, with no interpolation/translation suffix or general runtime-expression meaning. Ordinary strings remain values/descriptions. Optional definition-owned `agent=profile` selects a logical recipe; a named use cannot override its shared definition. Ordinary When scenarios/handlers retain authored Can `do` bodies, signatures, permissions, guards and independent examples. A prompt literal is invalid as a `do` body; execution/effects required by novel Given semantics still integrate through canonical owners. The marker records intent: ordinary builds make zero AI calls and explicit generation invokes the configured CLI.

The feature must not require verbatim CSS or JavaScript embedded in `.can`. Style definitions and inline one-off attachments carry prompts and optional profiles; named applications reuse the definition, without a new typed CSS/token map. Existing checked component options and editing saved implementation files remain supported.

### BGEN 02 Complete generation targets

All three categories participate in the shared lifecycle. Top-level `style Name $"prompt"` defines reusable CSS in the owning Then namespace without a visual body. Ordinary rendered components, pages and custom component instances carry one attached `$"prompt"` or `$Name` style suffix; nonvisual data/guard/schema declarations are not targets. This supersedes ordinary wrapper-style uses and excludes top-level anonymous style scopes. Ordinary reusable view children support attachments. Prompt-rendered views retain the renderer prompt in their header and carry their root style as an optional second `$"prompt"` or `$Name` suffix on that same header, binding declared renderer-root/part hooks, with the finite host-rendered child contract below. Definition-owned styles generate once per definition, not per instance; caller styling obeys child-host/interior ownership.

A named style definition is the sole generation unit for its CSS. Every use has a separate compiler-owned instance root and hooks, shares saved CSS, and requires zero AI calls and no copied generated output. Resolve names in the owning package/app Then namespace. No style exports, cross-package imports, parameters or style inheritance are admitted initially. Duplicate/unknown/cyclic references and incompatible ownership or part contracts diagnose. Styles cannot change data or authority. Generate against the actual checked use contracts and, for refinement, the saved CSS through the existing lifecycle. A new compatible use consumes that CSS without regeneration; an incompatible hook/template contract diagnoses instead of changing or regenerating it.

Generated declarations and implementation must expose the fields, interfaces, actions and effects needed by compiler analysis and runtime integration. A successful coding-tool response alone cannot create an invisible schema, operation or privileged callback.

Named traits and named custom keywords are definition-owned units: compatible applications reuse their saved implementation without additional AI calls. An inline trait owns the attached one-off model/field behavior. Traits retain checked model/field contributions applied in source order: model traits can add fields and supported model invariants/hooks; field traits add compatible constraints/defaults to their field, without sibling fields. Reject incompatible targets, duplicate contributions and contradictory defaults; traits cannot grant authorization or invent operations from a prompt. Their effects retain canonical operation/hook ownership. A custom keyword defines a new standalone Given declaration with its own target, arguments and implicit semantics. Its acceptance requires novel behavior unavailable in current Can and is not met by trait contributions/reuse. Contracts must expose target, typed inputs/outputs, reads, effects, lifecycle, dependencies and authority as needed for compiler/runtime integration. The frozen D1/D4 v1 contract supplies explicit compile-time signatures and checked owner-versioned producer bindings; no anonymous inline keyword prompt is a generation target. Reject contract mismatches, built-in redefinition, duplicate contributions and contradictory defaults where applicable. New behavior may require compiler/runtime capabilities that do not yet exist; implementing those is part of this requirement, rather than grounds to exclude the behavior. Preserve canonical operation, authority, storage, transaction, replay and migration ownership; new effects or permissions must be visible and admitted by their normal owners.


Pure checks on required native text fields may accompany named/inline trait
contributions as saved `implementation.js`. The source-derived contract fixes
`state.field-validation@1`, export `check(value)`, text input, Boolean result,
`validate-fields` lifecycle and no reads/effects/authority. The single-field
`contributions.can` template may specify only `value:text` when there are no extra
native constraints. State checks the normalized, hook-adjusted candidate on every
create/update before publishing state, history or key claims; only strict `true`
succeeds. False, exceptions and other return types produce canonical validation. Desired migration checks cover staged and retained rows. Implementation/import
bytes are fingerprinted separately from the contribution carrier. Model traits,
nullable and other field types do not admit this executable profile. Saved modules
retain the existing trusted-code boundary; no general JavaScript sandbox is implied.

The implemented model-field contribution profile admits the existing native
Boolean/integer aliases, decimal, text, email, timezone, date, datetime, duration,
money, user, file and inline enum associations, optionally one array wrapper and
outer nullability. Explicit defaults are required, including null and empty-array
defaults. Unsupported native associations and nested arrays diagnose instead of
producing an artifact State cannot install. Literal field labels use the receiving
source locale and checked ICU syntax; other generated caption forms diagnose. Field constraints preserve authored labels and translations.

A prompted row-bound view may declare canonical `card` roots, checked `edit`,
`delete`, `form`, `action`, `actions` and `button` controls, `text`, `content` and
`history` display bindings, and whole-view `require` guards. This is a finite
set of direct children, not permission to use an arbitrary component as a direct
root. Cards retain their ordinary typed UI descendants and local guards. A
source-owned card is passed whole as one opaque binding, including its content,
primary footer and secondary heading menu. The generated renderer must preserve
that complete binding; it cannot extract or reposition nested controls. A view
is not an action owner: `primary` and `secondary` need a canonical owner such as
a card, and existing form-submission and placement restrictions still apply. Slots, nested `show`, arbitrary props, caller capture and cross-package view
exports remain excluded at any depth.

The compiler evaluates the row once, applies whole-view guards before rendering,
and pre-renders direct children in source order through their canonical factories. Bindings use the source child kind (`card`, `edit`, `delete`, `form`, `action`,
`actions`, `button`, `text`, `content`, `history`), with repeated names suffixed
`2`, `3`, and so on. An action button retains `button` even when its factory
implementation is a protected form. A local guard may produce an empty binding;
it does not become a whole-view guard. The renderer receives admitted row data,
these complete HTML bindings and escaping helpers. It arranges each binding once,
unchanged; optional browser code uses canonical submission helpers. One optional
root-style suffix belongs on the view header. No generated permission grants or
new mutation path are admitted. Syntax acceptance does not establish every
component's emission/runtime profile; unsupported profiles must diagnose through
their existing owner.

### BGEN 03 Coding tools and models

Provide CLI-backed generation adapters for Codex, Muse Code, Claude Code and OpenCode when their supported executable, authentication and model are available. Each adapter must support noninteractive generation, explicit model selection, completion or failure reporting, bounded execution and the custom build-time MCP session. Before launch, diagnose unsupported MCP transport or inability to enforce the generator write restrictions; do not silently fall back to agent-written output files.

The CLI runner and the model are separate controls. Record the requested model and the actual provider/model reported by the tool when available; report unavailable resolved identity honestly. Unsupported models or capabilities produce actionable errors. Do not silently substitute another runner, model or permission mode.

The initial implementation uses installed CLIs and their native authentication. A direct API adapter may be added later through the same generation contract; it is not required for the initial feature.

### BGEN 04 Shared generation configuration

Runner, model and bounded execution preferences must be reusable at project scope through `can.gen.toml`, version 1, with shared generation settings, optional named profiles and explicit per-run overrides. `.can` may reference a logical profile but must not need repeated tool binaries or model recipes beside every prompt.

Resolve configuration from the supplied project root and report the effective configuration. Machine-specific settings and authentication remain separate from committed app intent. Generation configuration must not become a source registry, dependency manifest, duplicated app definition or authorization source. Credentials must not appear in generated code, browser assets or committed metadata.

Profiles require complete runner/model pairs; optional finite limits reuse shared limits without an inheritance graph. Then selects the reserved `frontend` recipe when configured, otherwise shared; Given selects shared; ordinary When has no generator recipe. Run profile selection overrides the owning declaration's optional profile, then the category default applies. Unknown explicit profiles diagnose. No backend role is required.

An explicit `--settings FILE` replaces the root file; explicit run values override the selected recipe. Do not search ambient user/local/ancestor configuration. A runner override requires an explicit compatible model. Report values and origins. Native adapter options remain specific to their recipe and capabilities. Changing tool or model affects future attempts; it does not replace compatible existing code or invoke generation during an ordinary build.

### BGEN 05 Saved outputs and ordinary builds

Persist generated implementation and the minimal source association and interface metadata needed to build it. Track current implementation so a clean checkout can build the saved code without the generation CLI, its login or a model call.

Current files live under tracked `can.generated/<opaque-unit-id>/`: `unit.json`, JavaScript/CSS, compiler-visible `contributions.can` and owned assets only where needed. ABI version 1 and truthful provenance accompany the association. Candidates, execution records, journals and leases live under ignored `.can/gen/`. A custom MCP server hosted by the private generation tooling owns candidate placement: build-time coding agents submit structured CSS, JavaScript and other admitted generated content against opaque allowed output targets supplied by the checked session. Callers cannot choose arbitrary filesystem paths. The host validates session targets, output roles and content, then writes isolated candidates and their minimal association metadata/provenance. Submission never overwrites current saved code or constitutes acceptance; validation, leases, attempt fences and conditional promotion still apply. Generation never commits to Git implicitly.

Normal build, check and bundle operations use current saved bytes, including compatible direct edits. They must not regenerate missing or stale implementation silently. Return the concrete affected unit and a generation or reconciliation action. Explicit generation preparation can be composed with a build, but must be identifiable as generation.

The ordinary compiler continues to derive schemas, HTTP/MCP/form interfaces, resource requirements, migration plans and application bundles from owning declarations and accepted implementation. Do not add a second authored dependency or interface manifest.

### BGEN 06 Stable internal source/output associations

Each named trait definition, attached inline trait, named custom-keyword definition, named style definition, inline style attachment and custom component implementation has a discoverable generation identity and owned output group. Named trait/custom-keyword applications reuse their definition without an independent generation identity or copied output group; anonymous inline keyword prompts are excluded. Named style applications have instance roots/hooks but no independent generation identity or copied output group. Identity must be separate from prompt freshness and transient source offsets or ordinals. Preserve associations across unrelated edits and formatting; ambiguous moves, copies or renames must diagnose rather than attach the wrong saved implementation.

Named and inline units must both be discoverable through structured inspection, with owner, source location, kind, target and concrete current/candidate paths. Inline units must not require editor selection or an author-written name. Opaque identities are internal source/output associations and may support inspection and direct-file editing; callers need not author or select per-prompt names or IDs to retry. Names serve semantic reuse of traits, custom keywords, styles and components, rather than retry selection. Copied definitions or inline units cannot accidentally share mutable implementation ownership. Repeated applications intentionally share their named definition's saved CSS. Inspection reports that definition and every checked use site, including prompted view root uses.

Allocate opaque IDs through tracked minimal association records. Match only uniquely supported owner/kind/label/normalized-structure evidence; a prompt-only edit may preserve an unchanged unique non-prompt anchor. Do not infer association by nearest offset, prompt similarity or a sole unmatched pair. Explicit `bind` supplies a current source location/revision and an existing ID or `new=true`; copies receive new IDs.

### BGEN 07 Full retry scope and preservation of saved work

Manual retry includes every generation prompt in the active app/build dependency closure, including successful and preferred styles. It requires no per-prompt source names, IDs or target enumeration. Unrelated applications in a draft repository are outside that scope; ambiguous active-app selection diagnoses through normal app selection rather than guessing.

Retry produces fresh candidate outputs from current source intent, checked contracts and effective recipes. Existing saved implementation and manual edits remain current until explicit or agent acceptance. Reset and cancel discard or fence pending work, never delete working code. Direct editing and targeted refinement remain available; they do not narrow manual retry to a failed or disliked prompt. Logical source/output associations do not determine runner execution granularity. The frozen D6 contract groups jobs by compatible effective complete recipe, prepares Given declarations before dependent frontend consumers, and supplies every frontend job the entire active Then context and all style/view intents/use contracts. All required full-retry outputs form one validated candidate acceptance set; incomplete/failed/conflicting sets preserve every current group. Selective refinement retains its declared scope.

A local style change must remain within its declared selectors and hooks; it cannot modify global theme/shared assets as a side effect. Existing semantic elements expose ownership/root/part hooks. A parent can style a child-scope host's placement, size and inherited inputs, but cannot traverse into its interior. Ordinary inheritance/theme/geometry dependencies remain explicit; selector isolation does not promise pixel isolation. Reusable trait/custom-keyword/component/style definitions affect their applications/uses; inspection walks the checked graph and exposes all source sites/owners without a new persistent use index. Refining a selected named style definition changes its uses while unrelated unit bytes remain unchanged. Adding a compatible use does not regenerate the definition; incompatible ownership/root/part or template contracts diagnose. Two regions within one style block share one logical association; direct editing can still change their saved CSS. Separate scopes express separate ownership, not a retry-selection requirement.

Parse and enforce ownership for generated and directly edited CSS, including supported nesting and guards on every selector compound. Support local selectors, conditions and namespaced keyframes/custom properties. Initially reject global escapes, unsupported relational selectors, `@import`, `@font-face`, remote asset URLs and traversal. Local styles can read shared theme variables but cannot redefine them; use existing theme/system fonts and owned assets.

### BGEN 08 Direct implementation access

The end-user AI agent authoring `.can` must be able to inspect and directly edit the associated tracked JavaScript and CSS under ordinary workspace permissions. Generated files are primary implementation inputs, not disposable build output or inaccessible internal blobs.

Source-compatible direct edits do not require another AI call or an additional candidate ceremony. Builds use the current files. If a direct edit changes lasting intent or a declaration contract, the authoring agent must be able to update the source and reconcile compatibility without being forced to regenerate through an AI.

Agents/tools obtain brief `edit.begin` / `edit.end` write leases for exact current-unit/source paths, then use ordinary workspace file edits. This is coordination, not a permission prompt or candidate approval. Capture, adoption, promotion and build readers honor the same protocol. Compatible byte edits alone do not require `adopt`. This direct-edit workflow remains allowed for the end-user authoring agent; it does not authorize the build-time generator to write source, current implementation or candidate files. That generator submits content only through the custom MCP server.

### BGEN 09 Distinct generation and refinement operations

Refine starts from current implementation, including direct edits, together with current source contracts and a supplied instruction. It produces a separate candidate.

Fresh generation deliberately requests a new implementation from source intent rather than treating the existing implementation as its design baseline. It still retains current files until replacement is accepted.

Manual retry starts a fresh capture of every generation prompt in the active app/build dependency closure using current source intent, contracts and recipes, including prompts whose previous outputs succeeded or were preferred. It is not continuation of a selected failed capture and does not use existing implementation as its design baseline. Saved code and manual edits remain protected until acceptance. Resume or recovery continues a specific recorded session/request only when the adapter supports it and the capture remains applicable. These operations must not be conflated.

### BGEN 10 Consistent candidate promotion

Acceptance is callable by the authoring agent. No dashboard, graphical preview, editor picker or human confirmation is required. A composed generate/refine, validate and accept operation must preserve the same checks as separate operations.

Before promotion, obtain the relevant cooperative leases and compare source/contracts/target inputs, current implementation bytes and attempt state with the capture. An intervening participating edit, source change, reset or newer acceptance prevents replacement. Retain the candidate and report the conflict; never overwrite the newer participating work. This guarantee covers participating writers/readers. An arbitrary editor ignoring leases may race the final comparison; byte checks and a journal do not provide filesystem compare-and-swap protection. Observed unexpected changes still refuse destructive promotion/recovery.

Acceptance uses one run journal containing all old/replacement groups in its declared scope; full retry accepts all required candidate outputs together after complete validation. Under cooperative leases and current-input/byte/fence checks, stage the complete set before atomic per-file replacements and gate build readers until commit. Before commit, recovery restores the whole old set; after commit, it finishes the whole new set. Recovery is idempotent, refuses unexpected bytes and retains conflict material. Builds refuse unresolved journals, snapshot consumed inputs under read leases and compile that immutable snapshot. Qualify supported durable file/rename operations and diagnose unsupported guarantees; this protocol is not filesystem CAS. Selective refinement uses the same mechanism at its affected scope.

Retain one previous current group including direct edits as an explicit rollback target; further available history can use source control. Long-running generation holds no write lease. Leases never expire or get stolen automatically: interrupted-lease recovery requires confirmation that its writer has stopped.

### BGEN 11 Runtime and language contracts

Generated server JavaScript must be compatible with the selected workerd version/configuration, supported APIs and declared bindings. Generated browser code has its own target and receives only admitted presentation data and canonical action bindings.

Use compiler-owned wrappers and checked owner-versioned producer schemas. Descriptors expose definition/application identity, target/arguments, saved export, exact inputs/results, lifecycle binding, reads/dependencies, effects, authority and finite bounds. Source declarations and checked owner-attached contributions establish contracts; wrappers derive runtime artifacts and the host derives minimal `unit.json` association/provenance. No second authored registry or runtime self-registration is permitted, and no JS runs to discover schema/authority. Existing `run`, pure `defaultValue`/`check`, `render` and optional `mount` roles remain usable where appropriate, without limiting custom-keyword capability. Canonical owners admit bindings and implement new producer/reference kinds needed by accepted novel semantics; metadata alone cannot register authority or storage. Can retains field grants, exact values, guards, versions, ordering, transaction commit, failure/replay and migration ownership.

Expose admitted compiler-bound sequential async effects through canonical owners, never raw HandlerContext/store/registry/principal mutation/commit. Extend integration where genuinely new keyword behavior requires it; the current producer set is not a feature ceiling. New effects and authority must be declared, checked and admitted by their normal owners, not inferred or silently granted from generated code. Validate arguments before suspension; permit one active effect, reject overlap/pending return/late calls and retain canonical failure even if JS catches it. Reads observe preceding staged writes; validate/project the final result before the existing single fenced commit. Failure/conflict preserves business-state rollback; canonical receipt bookkeeping retains its existing semantics. Replay does not rerun generated behavior. Exact codecs and admitted record associations remain owned by the existing packages.

The initial execution model is trusted application/workspace JavaScript, with admitted compiler producer and unit-local imports. Undeclared storage/network effects and privileged imports violate that application contract. Import/target checks and a narrow interface do not prove arbitrary JS purity or hostile-code containment; no separate sandbox/interpreter is required.

The interface must make new local Given keyword semantics, including any generated fields/rules and declared integration behavior, and component bindings inspectable and usable by their checked consumers. Existing Can analysis does not typecheck arbitrary JavaScript or prove its semantics; the new integration must supply its own finite contract and checks.

The initial independently specified novel keyword uses `state.unique-key@1`: pure checked text input/result, a compiler-owned model/field/rule binding, and canonical old/final key evaluation and fenced claim/release staging. NFKC normalization followed by ASCII lowercase preserves stored spelling without a helper field. Generated code cannot choose claim namespaces or submit raw claims. The compiler derives computed-key descriptors and saved implementation/import-closure fingerprints into schema evolution; changed code, including direct edits, requires installed-row/collision validation before activation. Failed activation retains prior schema/claims. This producer is one integration, not an extension ceiling.

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

The private tooling host starts/stops the bounded custom MCP server/session; no new package or persistent daemon is required. Frozen tools are `generation_context` for immutable checked context and allowed handles/roles, and `generation_submit` for batches of `{target, role, content}`. UTF-8 code/text and checked encoded binary assets are admitted against session-bound handles, never arbitrary paths. Invalid/stale handles, roles, duplicate/conflicting submissions and malformed content refuse; the host writes isolated candidates/metadata and separately verifies required-output completeness. Submission cannot promote. Concrete transport remains adapter-specific and must support enforced protected no-write access before launch. Multiple submissions/artifacts in one coding job do not imply one model call.

Manual retry resolves active app scope without per-prompt IDs/names. Other scoped unit/attempt controls retain explicit selectors. `generate` chooses `prepare` or `fresh`; `accept=true` composes capture, MCP submission, validation and conditional promotion without weakening checks. Identical repeated request IDs recover/return the same operation without duplicate launch; changed inputs conflict. Jobs group by compatible effective complete recipe; each frontend job receives whole-Then context, and all required full-retry outputs validate/accept together. Incomplete/failed/conflicting sets remain inspectable and preserve every current group. Selective refinement uses the same interface at its declared affected scope.

Results carry version/request/operation/selected IDs, state, paths, effective recipe, phase/validation summaries, structured errors and next actions. Distinguish `candidate` from `accepted`; requested acceptance cannot succeed after candidate production alone. Exit codes: 0 requested outcome succeeded; 2 invalid request/config/selection; 3 conflict/held lease; 4 validation failure; 5 runner failure; 6 unknown completion.

The required capabilities are:

| Capability | Observable behavior |
| --- | --- |
| Provider check | Reports adapter availability, supported MCP transport/write enforcement, controls and actionable authentication/model issues without coding generation |
| Status and inspection | Returns unit IDs, source association, paths, targets, freshness, direct-edit state, recipe and attempt state |
| Bind | Reconciles one explicit source location/revision with an existing ID or allocates a new independent ID |
| Generate and fresh generation | Coding agents submit content through the custom MCP session; the host produces isolated candidates for explicitly selected units |
| Retry and supported session recovery | Manual retry freshly regenerates all prompts in the active app/build closure, including successful/preferred styles, without per-prompt selectors; supported recovery continues a specific applicable recorded session |
| Refine | Uses current implementation and a new instruction as its baseline |
| Diff and optional preview | Returns machine-consumable differences and optional rendered artifacts |
| Validate and adopt | Checks candidates or directly repaired files and reconciles their current source association |
| Accept | Conditionally promotes compatible candidate outputs under the preservation checks; full retry accepts its complete validated set together under one journal |
| Cancel | Stops execution best-effort and prevents late results from promotion |
| Reset | Discards selected pending work while preserving current files and direct edits |
| Rollback | Restores an explicitly selected historical revision with compatibility checking |
| Edit leases and recovery | Coordinates exact editable unit/source paths; releases a token or recovers an interrupted lease only after its writer is confirmed stopped |
| Ordinary build/check | Consumes current saved implementation with zero AI calls |

The agent must be able to complete discovery, generation/refinement, checks, acceptance and build without a person using a generation UI. Optional editor and graphical integrations are not prerequisites.

### BGEN 15 Finite failure and recovery

Execution must have finite attempt and time limits, cancellation and structured progress/failure state. Do not create indefinite retry loops. Additional turn/spend/permission controls are supported only when the adapter can enforce them; unsupported requested controls diagnose. The runner must enforce that build-time coding agents cannot directly write source, current implementation or candidate files, including disabling generic file-write tools and shell write access as applicable. Prompt instructions alone are not enforcement. Unsupported MCP transport or unavailable enforcement diagnoses before launch.

Defaults are one bounded runner execution and 600 seconds per command; a CLI job may make multiple model/tool calls. The selected recipe grouping applies these limits per requested runner execution; one full retry may require several compatible-recipe jobs. Larger finite settings are explicit. Bounds apply to each requested execution; a later explicitly requested retry is still available. Automatic repetition of known-failed work, if supported within explicit bounds, is distinct from manual full retry; unknown completion cannot repeat automatically. Reset/cancel/new acceptance advance the attempt fence before releasing coordination.

Missing tools/authentication, unsupported models, permission needs, validation failure, cancellation and conflicts retain current code and unrelated units. Reset removes pending attempt/candidate state, not current implementation. Rollback is the distinct operation for restoring previous files.

A timeout or disconnected process does not prove provider work stopped. Report an unknown outcome distinctly, recover by a specific request/session identity when possible, and make possible duplicate work/cost visible before an explicit new attempt. Late or superseded results remain candidates and cannot promote themselves. Honor the configured CLI/task permissions instead of silently disabling them for headless operation.

## Acceptance scenarios

These are finite conformance outcomes for the future implementation, not claims of executed tests or additional implementation tasks. Each refers to the requirements above.

| Scenario | Required observation | Requirements |
| --- | --- | --- |
| Generation categories | Discover/generate a named model/field trait, reuse it without AI, and generate a one-off attached inline trait with its own output association. Separately define/generate a named custom Given keyword defining a new standalone declaration with its own target/arguments and genuinely new implicit behavior unavailable in current Can; trait contribution/reuse alone does not meet this outcome; anonymous inline keyword definition/application prompts refuse; a second compatible application reuses its saved implementation with zero AI calls, ordinary built-ins stay unchanged, and target/type/authority mismatches refuse. Exercise independently authored success, refusal, failure/conflict and canonical replay for that behavior where relevant. Use the canonical-identity fixture: `"Ａlice"` then `"Alice"` conflicts, `"Bob"` succeeds, stored spelling remains unchanged and no helper field is added; include final-key swaps and deletion/release. Also discover/generate component-attached Then styles and a same-module row-bound view with canonical controls and style root uses using mandatory `$"..."` literals. Ordinary When bodies remain authored Can with no generation unit or recipe; a prompt marker as a `do` body refuses. Ordinary strings remain values/descriptions, malformed/unmarked generation slots and unsupported component inputs refuse. Each uses its checked contract and actual runtime target | BGEN 01, 02, 11, 12 |
| CLI and model choice | Select each supported installed/authenticated runner and an available model; report effective identity. Verify the custom MCP session supplies checked context and opaque allowed targets, permits multiple structured outputs in one job, and the host alone writes candidates/metadata/provenance. Arbitrary caller paths, invalid targets/roles/content and direct generator source/current/candidate writes refuse. Unsupported MCP transport or write enforcement diagnoses before launch; submission cannot promote or overwrite current files | BGEN 03, 04, 13, 15 |
| Saved build | Generate through host-owned MCP candidate placement and accept through the existing validation/leases/fences/promotion checks once, then rebuild from saved files and a clean checkout without generation credentials or a coding-model call | BGEN 05 |
| Full retry updates all generation prompts | Define one named style used twice with separate instance roots/hooks and one inline one-off attachment. Compatible uses share saved CSS with zero AI and no copied output; inspection exposes all uses and incompatible contracts refuse. After one style succeeds and is preferred, manually retry the active app without prompt names/IDs: regenerate both style prompts and every other generation prompt in its build closure from current source/recipes, keeping unrelated apps untouched. Current CSS/manual edits remain until acceptance; reset/cancel preserve them. Each compatible-recipe frontend job receives whole-Then context; all required outputs validate and accept together under one run journal, and an incomplete set changes no current output | BGEN 02, 06, 07, 09, 10 |
| Inline scope identity | Format or edit unrelated source without losing the saved attached inline-trait or inline-style association; copy/ambiguous relocation cannot reuse the wrong mutable output silently | BGEN 06 |
| Direct refinement | Inspect paths, acquire an edit lease, edit current JS/CSS normally, release it and rebuild without AI while retaining truthful original provenance | BGEN 08, 13, 14 |
| Concurrent participating edit | Edit current files/source under a lease while a candidate is running; its completion cannot overwrite newer work, and builders snapshot no mixed accepted group | BGEN 10, 15 |
| Interrupted promotion and lease | Interrupt each relevant replacement phase; builders refuse unresolved groups, recovery yields the whole old/new accepted set or a retained conflict, and interrupted leases are never stolen automatically | BGEN 10, 15 |
| Request replay | Resend identical request IDs without a second provider launch; changed input under the same ID conflicts, and unknown completion is recoverable or explicitly acknowledged before new work | BGEN 14, 15 |
| Reset and unknown completion | Reset/cancel selected pending work; current/direct-edited and unselected code remain intact, and late completion cannot promote | BGEN 07, 15 |
| Target and authority checks | Exercise relevant generated behavior in workerd/browser and preserve typed inputs, canonical permissions, conflicts and failure rollback through the defined interface | BGEN 11, 12 |
| Contract change and agent-only recovery | Expose source incompatibility, repair/refine and validate/adopt selected files, then accept/build through structured commands without mandatory human UI | BGEN 08, 12, 13, 14 |

## Accepted decisions

The human requires MCP-only generator submissions with enforced unavailable direct writes; end-user authoring agents retain lease-coordinated source/saved-code edits. Codex selects `generation_context` and batched `generation_submit` under the [implementation contract](../design/proposals/build-generation/implementation-contract.md), without claiming implemented or qualified tools.

The human requires fresh regeneration of every current prompt in the active app/build closure, including preferred styles. Codex selects whole-Then context per compatible effective complete frontend recipe and one all-required-output candidate acceptance set with one run journal. Given preparation precedes dependent frontend consumption. Partial failure preserves every current group; scoped refinement remains available. One CLI job may make many model/tool calls. Earlier unit-centered/independent-batch assumptions are historical.

The human clarification removes dedicated prompted When generation: ordinary scenario/handler bodies stay authored Can, and the marker is invalid as a `do` body. It retains accepted named and inline model/field traits and separately requires named custom Given keywords defining new standalone declarations with their own targets, arguments and novel implicit semantics unavailable in current Can. No anonymous inline keyword definition/application prompt is accepted. A custom keyword is not a named property trait, and trait contribution/reuse does not satisfy its acceptance. The clarification supersedes a model/field-only capability ceiling and any claim that the current ABI closes this capability; it does not remove traits. Codex freezes D1/general keyword carriers and D4/owner-versioned producer integration for the explicitly authorized Muse implementation, preserving extensibility through normal owner integration. Unaffected choices remain accepted, including row-bound views, participating write leases, static prompts and reusable styles. The [choice record](../design/proposals/build-generation/choices.md) records that boundary; the implementation plan retains finite source changes and producer/consumer handoffs without implying a working generator.

| Decision | Accepted resolution |
| --- | --- |
| D1 | Accepted scope: named and inline model/field trait prompts, plus distinct named custom Given keywords defining new standalone declarations with their own targets, arguments and novel implicit semantics. No inline keyword prompts. Codex-selected v1: explicit `keyword Name(signature) [agent=profile] $"prompt"`, standalone `Name key=value` applications, compile-time reference kinds and checked constants; no positional/default guessing. Mandatory static `$"..."` literals and same-module row-bound generated `view` with canonical controls, reusable named style definitions, `$Name` attachments and inline `$"..."` attachments remain accepted |
| D2 | Root `can.gen.toml`, complete runner/model profile pairs, shared defaults for Given and implicit frontend for Then; ordinary When has no generator recipe; explicit settings/run overrides and native adapter controls; custom MCP transport and enforced generator write restrictions must be supported before launch |
| D3 | Opaque IDs in tracked association records; editable current files under `can.generated/<unit-id>/`; explicit reconciliation of ambiguous association; host-owned isolated candidate placement from checked opaque MCP submission targets |
| D4 | Accepted constraints: compiler-visible contracts, trusted application JS targeting workerd, checked wrappers, canonical authority/storage/transaction/replay, ordered admitted effects, exact values, truthful maps and finite actual-target checks. Codex-selected checked owner-versioned producer schemas, exact contracts and canonical wrapper admission; initial `state.unique-key@1` does not limit future owner-integrated producers |
| D5 | Existing-element ownership/part hooks, scoped selectors with ordinary inheritance and explicit child-host boundaries; checked-use graph inspection |
| D6 | Versioned JSON dispatcher and `accept=true`, custom build-time MCP submission without direct generator file writes, cooperative leases and snapshotting build readers retained. Manual retry is full fresh active-app regeneration without per-prompt selection. Codex-selected compatible-recipe jobs with whole-Then context, all-required-output validation/acceptance and one run journal; partial failure preserves current groups; earlier selected-attempt retry and unit-only batch assumptions are superseded for retry |

## Initial exclusions

Direct API generation adapters, mandatory human generation dashboards/review flows, automatic model fallback, unbounded retries, generation during ordinary builds and automatic deployment are not required. Arbitrary component props, slots, nested show, caller capture and cross-package exports; hostile-JS isolation; uncooperative-writer CAS; global CSS/font/import generation; and new typed style maps are outside the initial scope. Named and inline model/field traits and distinct named custom Given keywords with novel implicit behavior are required. Anonymous inline keyword definition/application prompts are excluded; trait contribution/reuse is not custom-keyword acceptance. The marker does not itself establish semantics; the frozen D1/D4 contract supplies the selected v1 carriers/integration, with future owner-integrated reference/producer additions remaining extensible. Existing SaaS, authority and migration constraints remain effective.

The [structured design record](../design/proposals/build-generation/proposal.json) and [decision history](DECISIONS.md) retain rationale and alternatives. This file owns the feature's required observable outcomes; older drafts do not independently expand its scope.
