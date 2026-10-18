# Build-generation implementation contract v1

Status: Codex-selected implementation choices for the human-authorized Muse run on 13 October 2026. Required outcomes remain owned by [BUILD_GENERATION_REQUIREMENTS.md](../../../specification/BUILD_GENERATION_REQUIREMENTS.md); [implementation-plan.md](implementation-plan.md) remains the single execution checklist. These interfaces are frozen for that run. A demonstrated contract gap requires an explicit, recorded handoff before affected writers continue; it does not authorize silent narrowing of the feature.

The three JEV requests and results advise these choices. The keyword surface has weak, split advice; the choice below follows verified parser shapes and concise authoring rather than claiming consensus. Other choices have consistent preferences with remaining uncertainty. The human selected the required outcomes; Codex selects this finite implementation under the explicit implementation authorization.

## Source and discovery

Given retains named `trait Name $"..."` definitions, direct checked model/field applications, and attached inline `trait $"..."`. Named traits own reusable contributions; inline traits own one attachment. Neither defines a standalone custom keyword.

A custom keyword has a required name, an explicit compile-time signature, and a static prompt. Its applications are standalone Given statements with named arguments:

```can
Given
 keyword canonical_identity(target:model, field:field(target,text)) $"Use the field's NFKC-normalized, ASCII-lowercased text as a canonical unique key, preserving its stored spelling and normal permissions."
 Account {handle:text}
 canonical_identity target=Account field=Account.handle
```

The defining carrier is `keyword Name(signature) [agent=profile] $"..."`. The application carrier is `Name argument=value ...`. Parameters are named and required in v1; duplicate/missing/unknown arguments diagnose. No implicit positional arguments, executable Given bindings, keyword prompt on an application, anonymous keyword definition, default guessing, or built-in redefinition is admitted. Definition collection precedes application resolution, so discovery works before saved implementation exists. Written model forms (`Name {...}`, existing `in`/`at=` ownership forms) retain their meanings; other unresolved custom Given statements are retained structurally and checked against collected keyword definitions. A name cannot ambiguously refer to a builtin, model or trait declaration form.

Compile-time signature kinds distinguish declaration references from runtime values. `model`, `field(target,type)` and `operation` are owner-checked reference kinds; ordinary scalar/enum and array types carry checked constants. A dependent field reference must belong to its named target and match its declared field type. References expose declaration metadata, not runtime row access or authority. The compiler-owner reference-kind registry is extensible; these initial kinds are not a model/field ceiling on custom keyword semantics. A required new kind needs its concrete owner implementation and checks.

Then follows the human's component-attached styling form:

```can
Then
 style FieldSurface $"Readable, comfortable fields with clear keyboard focus."
 page / title="Tasks" $"A calm task workspace; stack on narrow screens."
  card "New task" $"A compact entry area."
   form Todo.create fields=title
    input title $FieldSurface
```

Named styles are definitions directly in the owning Then namespace, with no visual body. Ordinary rendered components, pages and custom component instances accept one style suffix: static `$"..."` or `$Name`. Nonvisual data/guard/schema declarations do not become style targets. Definition/use context and actual root/part contracts determine compatibility; uses introduce no generation output or AI call. Ordinary style wrapper uses are superseded by attachments for the implementation. Generated view definitions retain their renderer prompt in `view Name(row:Model) $"..."`; an optional second suffix on that same header (`$"..."` or `$Name`) styles its renderer root. Its direct children follow the [finite generated-view contract](../../../specification/BUILD_GENERATION_REQUIREMENTS.md): canonical cards and controls, text/content/history display bindings, and whole-view require guards. The `style` keyword appears only in the top-level named definition; there is no inline, wrapper or leaf `style` statement, and no top-level anonymous style scope. Caller instance styling respects the child-host/interior ownership rule.

Existing optional logical profiles remain generation-definition-owned. Inline prompt attachments may select a profile through the owning declaration's `agent=profile`; named applications cannot select another recipe for a shared definition. Then defaults to frontend, Given to shared. Ordinary When has no generation carrier or recipe. All prompt literals are static JSON strings with adjacent `$` and no interpolation.

Canonical cards keep their ordinary checked subtrees and local guards, and are passed to the renderer as complete opaque `card` bindings. Source child names survive factory lowering (`button action=...` remains `button`), with repeated names suffixed `2`, `3`, and so on. Row evaluation is once per instance; whole-view guards run before source-ordered child rendering. The generated renderer preserves each binding unchanged. Direct priority actions still need their concrete action owner; slots, nested `show`, arbitrary props and caller capture remain excluded. This reconciles the earlier controls-only wording with the accepted action-owner correction; it adds no runtime carrier.

## Typed owner integration

Use a checked descriptor selecting owner-versioned producer schemas, rather than a closed generated `run/default/check` role enum or raw host callbacks. The minimum descriptor binds:

- source definition/application identity and resolved target/arguments;
- saved module export and exact input/result schemas;
- versioned canonical lifecycle/producer binding;
- declared reads/dependencies, effects and authority admission;
- bounded execution and target compatibility.

Source declarations and checked owner-attached contributions establish the contract; compiler-owned wrappers derive the runtime artifact. The host assembles minimal `unit.json` contract/association/provenance from checked source and structured MCP submissions. Ordinary `contributions.can` remains the carrier for generated owning declarations where needed. There is no second authored registry, and JavaScript is never executed to discover schema, permissions or registration.

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

Model-field contributions use existing native State/Values associations and exact
default codecs: Boolean/integer aliases, decimal, text, email, timezone, date,
datetime, duration, money, user, file and inline enums; at most one array wrapper
and outer nullability. Explicit defaults remain required. Unsupported associations
and nested arrays refuse. Static literal captions flow through existing field-label
IR in the receiving source locale and use the existing ICU checker; unsupported
caption forms refuse. Constraint-only traits preserve source-authored captions.


Canonical owners publish their producer schemas and admit checked bindings. A metadata string cannot self-register authority, storage or a new lifecycle. Extend the relevant owner where accepted new semantics need a missing producer; the architecture is explicitly extensible beyond the initial producer. Generated exports receive projected exact inputs and admitted sequential effect handles, never raw context/store/commit/registry. Existing permission, mutation order, rollback, replay and exact-value rules remain governing contracts.

The first independently specified novel keyword integrates a new `state.unique-key@1` pure producer: checked text input and checked text result. Its compiler-owned binding identifies the source model/field and a rule namespace. State evaluates old/final keys, chooses canonical claim/release identities and joins its existing fenced commit. The generator cannot choose arbitrary claim namespaces or submit raw claims. This producer is one integration, not the whole extension API.

The compiler derives the computed-key descriptor and exact saved implementation/import closure fingerprint into schema evolution. Installing changed key semantics uses existing schema activation and validates installed rows and collisions before activation. Direct JavaScript edits also affect this fingerprint; an authored version label is not required. Failed activation retains the prior schema/claims and reports the collision or unsupported migration. No helper stored field or silent data rewrite is introduced by this acceptance fixture.

## MCP output interface

The private Node tooling host owns one bounded generation server/session for a captured run. Its minimal tools are:

- `generation_context`: return immutable source/contract/template/theme context and server-issued allowed output handles/roles; no secrets.
- `generation_submit`: accept a batch of `{target, role, content}` entries against those handles, then report host-written candidate status/diagnostics. Code/text is submitted as UTF-8; admitted binary assets use a checked encoded payload. The host chooses physical paths and records provenance/associations.

Handles are session-bound internal associations, not authored prompt names or arbitrary paths. Invalid/stale handles, roles, duplicate/conflicting submissions and malformed content refuse. The host records completion of the required output set independently of the runner's exit message. Validation and acceptance are existing separate lifecycle phases; submission cannot promote code. A coding job may submit several batches/artifacts without one model call per submission. Concrete transport uses a supported runner MCP attachment; unsupported attachment or protected-write enforcement fails prelaunch without file-output fallback.

Restrict generator tools and filesystem access so protected source/current/candidate roots cannot be written by the coding agent. The host alone writes candidate output. Native CLI internal housekeeping is isolated. Server-owned validation may run bounded compiler/target checks. The user-facing authoring agent retains normal source edits and lease-coordinated direct saved-code edits. This restriction applies to the future build-time generator, not the Muse agents implementing Can itself.

## Jobs, retry and promotion

Snapshot one active app/build dependency closure. `prepare` reuses compatible saved output and produces only explicitly required candidates; normal builds do not start a generator. Manual `retry` freshly generates every current prompt in that closure, including named/inline traits, named keyword definitions, all styles and views, even if previous output was preferred. Unrelated apps remain outside scope.

Group jobs by compatible effective complete recipe, with Given preparation before frontend consumers of its checked declarations. Each frontend recipe job receives the entire active app's Then context and all style/view intents/use contracts, and produces jointly considered CSS/rendering output for its assigned handles. Identical recipes coalesce compatible frontend work. Differing explicitly selected profiles may require multiple jobs; none may be silently replaced or ignored. This is whole-Then context, not one process per prompt. A CLI job may internally make many model/tool calls. Scoped refinement remains available through the same interface; it does not change full retry scope.

All required full-retry outputs are one candidate acceptance set. An incomplete/failed/conflicting set remains inspectable and preserves every current group. The user's subsequent acceptance-gate requirement adds actual candidate compilation, installed build checks, compiled Can examples and app-local Playwright against the real dev preview before promotion. Missing or failing checks refuse; candidate screenshots and reports stay outside current saved groups. After complete validation and execution checks, acceptance acquires the relevant leases, checks the complete captured source/current/contract/fence closure, and stages one run journal containing all old/replacement groups. Atomic per-file replacement is gated from build readers until commit. Recovery before commit restores the whole old set; recovery after commit finishes the whole new set. Unexpected bytes retain conflict evidence; late/reset/cancelled results cannot promote. Retain one prior accepted set including direct edits for rollback. Selective refinement uses the same mechanism at its declared affected scope.

Ordinary builds snapshot saved consumed inputs under read leases, refuse unresolved journals and use zero AI/MCP processes. Journal/durability guarantees must be qualified for the supported platform. No filesystem CAS or hostile-JavaScript sandbox is claimed.

## Observable acceptance and ownership

Retain BGEN01–15, its 12 scenarios and BGI01–13. The canonical plan maps tasks to these interfaces; this contract is not another task checklist.

- Named trait used twice and an inline trait qualify distinct contributions and saved reuse; anonymous keyword prompts refuse.
- The named canonical-identity keyword has a standalone use; inserting `"Ａlice"` then `"Alice"` conflicts, while `"Bob"` succeeds, without changing stored spelling or adding a helper field. A second compatible model application reuses saved code. Target/type mismatch, final-key swaps, deletion/release, permission refusal, failed transaction and canonical replay have independently authored expected outcomes.
- A whole-Then frontend job submits multiple style/view outputs through MCP; protected direct writes and arbitrary output paths refuse. Full retry includes a preferred named style and an inline sibling; an incomplete set cannot change either current output.
- Journal interruption/recovery and a concurrent participating edit preserve old/new complete sets and fenced late results. Saved edited output builds from a clean checkout without generation credentials.
- Each supported CLI adapter is qualified through its actual available MCP/permission/model controls. Unavailable executable/auth/model/target gates remain named with owner/release conditions; they do not justify fallback or false closure.

The Rust compiler owns grammar/checking/descriptors/wrappers/CSS and saved intake. Existing Node tooling owns configuration, MCP/CLI execution, candidates/leases/journals and protocol. Canonical runtime owners admit generated behavior; UI/Interfaces retain semantic markup/control admission. Muse coordinates at most three parallel native-worker lanes with exclusive checkout file ownership and dependency handoffs. Codex independently reviews the critical contracts after writer/command release.
