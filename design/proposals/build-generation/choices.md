# Accepted build-generation choices

Status: accepted by the human, 13 October 2026, including row-bound views and cooperative write leases. This fixes the initial feature scope; implementation has not started. The [requirements](../../../docs/specification/BUILD_GENERATION_REQUIREMENTS.md) own outcomes. The [JEV consultation](../../jev/build-generation-decisions-20261013/summary.md) informs these choices; its split results are not presented as endorsements.

## Choices covering D1–D6

| Group / subchoice | Accepted choice | Reason and limit |
| --- | --- | --- |
| D1 `given_keyword` | `trait` | Reusable local vocabulary already used in the draft; means checked contributions to a model or field, with no inheritance semantics. |
| D1 `given_application` | Apply local words directly, in written order; inline `trait "prompt"` is also allowed | Concise implicit vocabulary. Resolve against the local trait namespace; reject duplicates, ambiguous words and built-in redefinition. |
| D1 `when_body` | `do "prompt"` replaces an ordinary `do` suite | Reuse the owning operation. Exactly one implementation form; no mixed prompted/ordinary body. Signature, permission, guards and examples stay explicit. |
| D1 `component_prompt` | `view Name(row:Model) "prompt"` | Reuse view/show. Optional definition-owned style blocks and canonical control declarations are the only children of a prompted view. |
| D1 `component_contract` | Same-module, one required nonnullable model row; checked canonical controls | Preserve once-only argument evaluation. No arbitrary props, slots, nested show or exports initially. Row-bound components can still have forms/actions. |
| D1 `style_overrides` | Prompt plus optional `agent=profile` | No new CSS shorthand/token map initially. Existing checked component options and direct saved-CSS edits remain available. |
| D2 `root_filename` | `can.gen.toml` at the supplied project root | One narrow tooling file, with no app/dependency/source registry. |
| D2 `config_schema` | Shared recipe plus optional named profiles; runner/model pairs are complete | Shared finite limits may be reused; no profile inheritance graph or accidental cross-runner model inheritance. |
| D2 `role_defaults` | Then uses `frontend`; Given/When use the shared recipe | An omitted frontend recipe uses the shared recipe. No required backend role. |
| D2 `precedence` | Explicit settings file or committed root file; run overrides last | `--settings FILE` selects a replacement settings file. No ambient user/local/ancestor search. Report effective values and origins. |
| D2 `runner_controls` | Shared attempts/time/cancel plus validated native adapter options | Keep actual permission/turn/spend semantics. Unknown or unenforceable controls fail before launch. |
| D3 `identity_carrier` | Tracked minimal association record with opaque unit ID | Names, positions and fingerprints are association evidence. Ambiguous changes require explicit bind/copy reconciliation. |
| D3 `file_layout` | `can.generated/<unit-id>/` | Track editable current implementation and `unit.json`; ignore candidate work, logs and leases under `.can/gen/`. |
| D4 `contracts` | Saved source-owned declaration contributions, checked by normal analysis | Derive one canonical schema/interface. Contributions cannot introduce an app, policy grant, privileged registry or independent dependency manifest. |
| D4 `effect_abi` | Narrow sequential async effect methods | Delegate to existing canonical producers, projected reads and staged writes. No raw context/store/commit. |
| D4 `execution_trust` | Trusted application/workspace JavaScript | Workerd compatibility and a checked interface are required. Hostile-code containment is outside this initial scope; ambient authority is an explicit trust limitation. |
| D4 `registry_join` | Compiler-owned wrappers import checked saved exports | Preserve current invocation, codecs, authority, versioning, transaction and replay owners. |
| D4 `source_mapping` | Map JS to current JS files, with separate Can owner link | Attribute generated implementation truthfully; do not invent executable locations inside prose. |
| D4 `target_checks` | Existing actual-target fixtures by unit kind; small harness only for a concrete missing case | Reuse unaffected checks. Independently authored behavior examples remain the expected result. |
| D5 `hook_carrier` | Ownership/root/part attributes on existing semantic elements | No compulsory layout wrapper. Custom renderers must expose the declared hooks. |
| D5 `nested_cascade` | Ordinary inheritance with explicit selector ownership and child-host rules | Parent styles may affect child placement and inherited values, but cannot select child interiors. Independent files do not imply independent pixels. |
| D5 `affected_use_reporting` | Walk the checked declaration/use graph when inspecting | No additional persistent use index. Return definition/use sites and owners; never widen generation. |
| D6 `request_carrier` | One versioned JSON request dispatcher | `can gen --request FILE` or `can gen` with stdin; one final JSON result, optional JSONL events. CLI sugar can come later. |
| D6 `compose_acceptance` | `"accept": true` on generate/refine | Capture → candidate → validate → conditional promotion, with phase results. No required human review. |
| D6 `promotion_recovery` | Brief cooperative leases, one unit journal and build-read gating | Per-file replacement is a primitive. The protocol provides consistent group consumption and recovery; it is not a filesystem CAS. |

## Source forms

The following is a syntax illustration, not compilable current Can. Ordinary pages, forms, lists and examples keep their existing syntax.

```can
Given
 trait completable "Add done:bool=false with Open/Done labels. Use the existing authorized update path."
 Todo {title:text trim min=1 max=200} completable
 Note {body:text} trait "Add pinned:bool=false."

When
 scenario complete(task:Todo) by=members
  do "Set task.done to true through the canonical update path."

Then
 view TaskTile(row:Todo) "Show the title, status and declared edit/archive controls in a compact accessible tile."
  edit fields=title,done
  delete
  style "Clear status badge, subtle border and visible keyboard focus."

 page / title="Todos"
  style "A compact task-entry area. Stack controls on phones."
   card "Add a task"
    form Todo.create fields=title
     input title
  style TaskList "Readable task rows with generous hit targets."
   list Todo as task
    show TaskTile {row=row}
```

Named traits are definition-owned generation units; applications instantiate and check their contributions without another model call. An inline trait belongs to its target. Changing a shared trait reports its affected applications, just as changing a shared view reports its uses. A modifier supports one checked target kind: model contributions can add fields and supported model invariants/hooks; field contributions can add compatible constraints/defaults to that field. Reject incompatible target types, sibling fields from field traits, contradictory defaults and duplicate contributions. Apply contributions in source order. Effects retain their existing canonical operation/hook owner; traits cannot grant authorization or invent operations from an instruction.

A prompted view's `edit`, `delete` and other supported canonical form/action declarations establish the bindings the renderer can arrange. They are not slots or arbitrary executable children. The compiler provides admitted row data, checked controls and existing presentation helpers. Browser code may enhance those controls and use canonical submission helpers. It must preserve field identity, version/CSRF data, validation feedback and focus behavior. Styling an ordinary view uses normal style blocks around its existing children. Definition-owned styles of a prompted view bind to its renderer root/part hooks.

## Configuration

```toml
version = 1

[generation]
runner = "codex"
model = "YOUR_SUPPORTED_MODEL_ID"
max_attempts = 1
timeout_seconds = 600

# Optional complete runner/model pair, selectable with agent=fast.
[generation.profiles.fast]
runner = "opencode"
model = "PROVIDER/MODEL_ID"
```

Model strings are placeholders, not promised model availability. The shared runner/model pair is required for generation, never for an ordinary saved build. Profile pairs are complete; optional limits use shared finite limits when omitted. Native options belong to the chosen recipe and adapter, with no cross-runner inheritance. One provider execution and 600 seconds per command are defaults; larger finite settings are explicit. Limits bound each requested execution, rather than preventing later explicitly requested retry commands. A larger attempt limit allows only selected, known-failed work to repeat; unknown completion never triggers automatic retry.

`frontend` is the reserved Then default: a configured profile of that name overrides the shared recipe; otherwise it resolves to shared. Given/When use shared. An explicit run profile overrides an owning declaration's optional `agent`, then the category default applies. Unknown explicit profiles diagnose. Children with their own generation units resolve their own defaults, rather than inheriting a parent's tool choice silently.

Choose `--settings FILE` instead of the root file when supplied, then apply explicit run overrides. Overriding the runner also requires an explicit compatible model. Report each effective field's origin. CLI authentication stays native and outside committed files. Optional native controls must be documented/enforced by the selected adapter. Recipe changes affect future attempts only.

## Identity and saved code

`can.generated/<unit-id>/` contains only the current unit's required files: `unit.json`, `server.js`, `browser.js`, `style.css`, compiler-readable `contributions.can` and owned assets as applicable. The compiler derives interfaces/imports/assets from checked declarations and current implementation; no second authored manifest is required. `unit.json` holds the opaque ID, source association, kind/target, `abi_version=1`, the minimal checked contribution/export contract and truthful original generation provenance. Original output fingerprints and current bytes are distinct facts.

Match a unique declaration using its owner, kind, optional label and normalized structural context, ignoring formatting/comments. A prompt-only change may retain an ID when the non-prompt anchor is unchanged and unique. Do not infer identity from a sole unmatched old/new pair, nearest offset or prompt similarity. A changed body/owner with insufficient evidence requires explicit `bind`: supply the inspected source location and source revision plus an existing ID, or request a new ID. Copies get new IDs. Conflicts leave the saved group intact and make builds identify the association requiring reconciliation.

Ordinary direct edits to current JS/CSS are immediately build inputs. `adopt` is needed only when reconciling source/interface drift, not for every compatible byte edit. Candidates and execution records live under ignored `.can/gen/attempts/<unit-id>/<attempt-id>/`. Historical source-controlled revisions and the one previous group retained at promotion provide explicit rollback targets; generation does not commit to Git automatically.

## JavaScript interface

Emit an interface for each unit, using checked source/contributions. Supported export roles are `run(inputs, effects)` for operations/hooks, pure synchronous `defaultValue(inputs)`/`check(inputs)` for defaults/rules, and `render({row, bindings, ui})` with optional browser `mount(root, presentation)` returning cleanup. Only the roles actually declared by the unit are admitted. A renderer cannot mutate application state. No module runs merely to discover its schema or permission.

Compiler wrappers validate inputs/results with existing Can exact-value codecs. Native record handles retain admitted model/row/version associations; an arbitrary JS object cannot impersonate a mutation target. Effects are closed, compiler-bound methods for checked models, operations and service bindings. They delegate to projected reads over the staged overlay, canonical writes and supported deferred effects. Unsupported shapes diagnose; a new service capability is not granted by its appearance in JS.

Authors await effect calls in order. Permit at most one active call; overlapping calls or returning with a pending call fail the invocation. Validate/capture arguments before the call's await, reject calls after closure and retain any canonical failure even if JS catches its rejection. Later reads see earlier staged writes. Validate/project the final result before the existing single fenced commit. Failure/conflict commits nothing; canonical replay does not rerun generated code. This discipline does not prove every property of arbitrary JS control flow.

Server exports target the selected workerd configuration; browser exports receive admitted presentation data and checked action descriptors. Allow checked compiler producer imports and unit-local modules/assets. Privileged imports, raw storage/commit access and undeclared network effects violate the application contract. The initial feature accepts trusted project code, as ordinary application source does; import checks and target tests are not hostile-code isolation. Pure callback/render contracts prohibit side effects, but finite checking is not a proof of arbitrary JS purity.

Use existing actual-target examples for relevant success, refusal, failure/conflict and replay outcomes. CSS-only changes require CSS/render checks, not unrelated workerd invocations. Maps point to current saved JS, with the owning `.can` location alongside it.

## CSS boundary

Attach unit ownership and root/part hooks to existing rendered elements. Every selector-matching element belongs to its nearest style unit. Nested child roots additionally expose a parent host hook; a parent rule may style that host's placement, size and inherited inputs, but may not traverse into its descendants. Custom view instances keep separate DOM identity while sharing definition-owned styling.

Parse saved scope-relative CSS, including supported nesting, and insert ownership guards on each element-matching selector compound. Support ordinary local selectors/pseudo-classes, parts, media/supports/container conditions and namespaced local keyframes. Reject global selectors/escapes, initially unsupported relational selectors, `@import` and `@font-face`. Use existing theme/system fonts. Namespace authored unit-local custom properties; shared theme variables are readable but not redefinable by a local style. CSS asset URLs must resolve to owned unit files; reject remote URLs and path traversal.

Scope enforcement applies equally to generated and directly edited CSS. Ordinary inheritance stays: parent typography/color, theme inputs and layout can change a child's appearance. Report those dependencies without claiming pixel isolation. Inspection walks checked trait/view uses, returning source sites and owners; validation can cover affected consumers, while generation still writes only the selected unit.

## Agent protocol and lifecycle

```json
{
  "version": 1,
  "request_id": "r42",
  "operation": "refine",
  "unit_id": "u17",
  "instruction_file": "change.txt",
  "accept": true
}
```

Required operations are `doctor`, `status`, `inspect`, `bind`, `generate`, `refine`, `retry`, supported `resume`, `diff`, optional `preview`, `validate`, `adopt`, `accept`, `cancel`, `reset`, `rollback`, `edit.begin`, `edit.end` and explicit interrupted-lease recovery. `generate` requires a mode `prepare` or `fresh`; it never guesses intent. Existing-unit mutations have an explicit unit ID. `bind` identifies one source location and revision, plus an existing ID or `new=true` to allocate one. Attempt operations also identify the attempt. Batch requests enumerate units and return per-unit outcomes; they do not imply batch atomicity. Instructions use text, a file or stdin, with exactly one chosen carrier.

The final result contains version/request/operation/selected IDs, state, paths, effective recipe, phase/validation summaries, structured errors and bounded next actions. Optional JSONL progress ends with the same final envelope. Exit codes: 0 requested outcome succeeded; 2 invalid request/config/selection; 3 conflict/held lease; 4 validation failure; 5 runner failure; 6 unknown completion. `accepted` and merely `candidate` are different states; requested acceptance cannot report success after candidate creation alone. A repeated request ID with the same input returns or recovers the existing operation; different input under that ID conflicts. It never launches duplicate provider work merely because the caller resends.

`refine` captures current edited files plus current intent/contracts and the new instruction. `fresh` captures the current group for conflict/rollback protection but supplies source intent instead of current code as the design baseline. `retry` repeats a known failed capture/recipe; changed inputs require a new attempt. Unknown completion requires supported recovery or an explicit new attempt acknowledging possible duplicate work/cost. Reset/cancel/new acceptance fence superseded attempts before releasing coordination. Late outputs remain inspectable and never promote themselves.

## Promotion, direct edits and recovery

**Accepted BGEN 10 scope:** concurrent replacement protection covers agents/tools participating in the write-lease protocol. Direct editing remains supported. Arbitrary writers ignoring that protocol can race a comparison and replacement; neither the existing helper nor a journal can guarantee preservation of every such write. Observed conflicts refuse promotion. The human explicitly adopted this boundary, now incorporated in BGEN 10.

`edit.begin` returns a token and exact unit/source paths; agents then edit those files normally and release with `edit.end`. The lease is coordination, not an AI call, candidate approval or permission prompt. Capture/adopt/accept coordinate the relevant source paths and selected unit in a canonical lock order. A build takes read leases, refuses pending promotion journals, snapshots the required current inputs and compiles that snapshot. Long-running generation holds no write lease; unrelated units remain usable.

Before changing current files, acceptance obtains the relevant leases, compares the captured source/contracts/target/current bytes and attempt fence, and confirms validation applies. It stages one selected-unit journal with the old group, replacement group and recovery state. Only then replace files with atomic per-file writes. Readers remain gated until all files/metadata agree and the journal records commit. Retain one prior group including direct edits for rollback. Exact crash guarantees use the chosen platform's supported durable file/rename operations; unsupported coordination/durability diagnoses instead of claiming a transaction.

Recovery under the same leases restores the old group for an uncommitted journal or finishes the new group for a committed journal. Unexpected bytes refuse destructive recovery and preserve both saved groups for reconciliation. Repeated recovery is idempotent; builds never consume an unresolved mixed group. A rollback is an explicitly selected compatible replacement using this same protocol.

Leases do not expire or get stolen automatically. A crashed writer requires explicit lease recovery after its process is confirmed stopped; unknown provider/writer activity stays unknown. The outcome guarantee is consistent consumption, retained current work on detected conflicts and finite explicit recovery under the cooperative protocol. Full hostile-code containment, uncooperative-writer CAS, arbitrary component APIs and global CSS generation are outside this initial scope.

The [implementation plan](implementation-plan.md) is the single current execution view. Accepted choices close D1–D6; exact file/type implementations belong to their finite tasks rather than reopening feature design.
