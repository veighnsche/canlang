# Build-generation implementation plan

Status: planning complete, 13 October 2026. The human adopted the [choices](choices.md) and finalized the [requirements](../../../docs/specification/BUILD_GENERATION_REQUIREMENTS.md). Implementation has not started. This is the single current execution view: canonical task IDs BGI-01–BGI-13, all planned. No source changes, provider runs or implementation tests are authorized by completing this planning step.

## Ownership and handoffs

- **Rust compiler:** source grammar, structural unit discovery, conservative association evidence, checked contributions/interfaces, saved-input intake, CSS parsing/scoping, emitted wrappers/artifacts and source maps. Existing `NodeKey` is not persisted identity.
- **Existing Node tooling host:** `@canlang/cloudflare` owns local configuration, coding CLI processes, structured generation operations, IDs/records, candidates, write leases, journals and target preparation. `can gen` is a thin Rust CLI delegation through the existing platform host; no new package or daemon.
- **Runtime packages:** Values owns exact representations/codecs; State owns admission, staged effects, commit and replay; Interfaces owns transport/form admission and projection; UI owns semantic markup, canonical controls and browser lifecycle. Cloudflare joins saved modules to these owners and workerd/browser packaging.

Proposed new private modules may live under `compiler/src/generation/`, beside compiler codegen for CSS, and `packages/cloudflare/src/generation/`. These are placement targets, not pre-created files. Keep local filesystem/process code out of worker modules. Existing source-capture helpers cover a limited first profile; they do not already provide the complete source/output closure, leases or promotion protocol.

Required handoffs are concrete data, not completion of another owner's whole lane:

1. Structural declaration descriptors: owner/kind/label, prompt/profile, source location/revision, normalized non-prompt anchor, target and declared contracts. Discovery must work before missing generated Given contributions make dependent application checking complete.
2. Associated unit records and a coordinated immutable snapshot of the relevant source/imports/contributions/current code/assets/target inputs.
3. Checked ABI-v1 export, exact-value, effect/control and use descriptors; one canonical schema/registry, without a second authored manifest.
4. A selected candidate plus captured inputs/current bytes/recipe/fence, applicable target-validation result and conditional promotion outcome.

## Tasks

### BGI-01 — Source carriers and unit descriptors

**Owner / targets:** compiler `syntax/{cst,parser,construct_help}.rs`, `format.rs`, `analysis/{mod,resolve,types}.rs`, `codegen/ir.rs`; owning additions to `packages/contracts/src/{artifact,presentation}.ts`. Update grammar/help/editor vocabulary with the relevant language change.

**Prerequisite:** accepted D1/D3/D4 scope. **Change:** parse named/direct/inline traits, prompted do, inline/named styles, prompted row-bound views and optional profiles. Separate structural discovery from full dependent checking. Define the minimal v1 descriptor/export/control shapes consumed by later tasks. Preserve existing ordinary syntax and examples.

**Done when:** positive source forms parse/format/discover; malformed/duplicate/built-in words, mixed implementation bodies, wrong row signatures and forbidden view children/slots/nested show diagnose. A missing generated trait exposes its unit for preparation instead of making discovery impossible. Reuse `authoring.rs`, `localized_format.rs` and `view_reuse.rs` for affected cases.

### BGI-02 — Stable associations and saved-group intake

**Owner / targets:** compiler `source.rs`, `analysis/mod.rs`, `cli.rs` and focused generation intake; Node generation record/association modules. **Needs:** BGI-01 structural descriptors and v1 record shape.

**Change:** allocate tracked opaque IDs, implement `can.generated/<id>/unit.json` and conservative unique association; expose explicit bind/copy reconciliation and concrete current/candidate paths. Intake only the owning unit's current files and derived import/asset closure. Preserve historical generator output fingerprints separately from edited bytes.

**Done when:** formatting/unrelated edits and uniquely anchored prompt changes retain association; copies/ambiguous relocation cannot reuse ownership; bind rejects stale source selectors; compatible edits are current build inputs. Missing/incompatible groups identify exact units/actions. No provider/config/login is consulted by saved intake.

### BGI-03 — Configuration and JSON command contract

**Owner / targets:** `compiler/src/cli.rs`; `packages/cloudflare/src/cli/platform.ts` and generation config/protocol modules. **Needs:** BGI-01 descriptor shapes and BGI-02 selectors/records.

**Change:** thin `can gen` routing; version-1 requests/results/events, typed operations/errors and exit codes; TOML shared/complete-profile recipes, explicit settings/run precedence and native capability tables. Select and pin a maintained TOML parser if none already available; do not invent a handwritten configuration parser.

**Done when:** supported schemas and exclusive instruction carriers validate; missing/ambiguous selectors, unknown profiles/keys/capabilities and incompatible runner/model overrides fail before launch. Effective values/origins are inspectable. Ordinary saved builds do not depend on generation settings. Operation handlers join through BGI-05/BGI-12; this task owns their common admission/output contract once.

### BGI-04 — Write leases, snapshots and journal recovery

**Owner / targets:** Node generation coordination/promotion modules; matching Rust generation intake/read coordination in `cli.rs`/`source.rs`. **Needs:** BGI-02 unit groups and source paths.

**Change:** one documented on-disk cooperative lease/journal protocol shared by both hosts, canonical lock order, exact edit paths/tokens, brief capture/accept leases and snapshotting build readers. Stage old/replacement groups before per-file writes; gate readers through commit/recovery. Retain one previous group, and support explicit stopped-writer lease recovery without expiry/stealing.

**Done when:** participating source/unit edits conflict correctly; capture/build uses one immutable consumed closure; interruption at relevant replacement/commit boundaries recovers the complete old/new group. Unexpected bytes retain conflict material, repeated recovery is idempotent and unresolved journals never serve a mixed group. State the supported platform durability behavior; never claim uncooperative-writer CAS. These focused fault cases qualify the mechanism once.

### BGI-05 — Candidate lifecycle and bounded Codex execution

**Owner / targets:** Node generation lifecycle/runner modules, reusing patterns from `cli/command-lifetime.ts`. **Needs:** BGI-03 requests/recipes and BGI-04 captured groups/fences.

**Change:** selected-unit preparation/fresh/refine; isolated attempts; idempotent request IDs; captured retry and supported resume; cancel/reset fencing; one adapter interface and Codex argv/model/structured-result handling. Never splice shell commands or silently relax permissions. Connect validation/promotion as explicit later hooks.

**Done when:** fake executable cases show correct argv/input/output ownership, matching-request recovery without duplicate launches, changed-request conflicts, current-edited refine baseline, fresh conflict protection, finite limits and unknown completion. Late/superseded output cannot accept. Unselected/current groups remain intact through known failure/reset/cancel. Real Codex access is the separate gate below.

### BGI-06 — Other required CLI adapters

**Owner / targets:** Node generation runner adapters. **Needs:** BGI-05 common execution/capture contract, not its entire integration programme.

**Change:** Muse Code, Claude Code and OpenCode adapters using the installed tool's supported headless/model/permission/session controls. Verify actual current help/primary documentation during implementation; do not assume desktop model identifiers or identical provider semantics.

**Done when:** each adapter's finite executable tests cover argument/model/capability/error/unknown-result behavior against the shared contract. Actual native authentication/model generation is qualified per adapter when its external gate is released. All four adapters remain required; the Codex-first milestone does not reduce scope.

### BGI-07 — Checked contributions and emitted wrapper contracts

**Owner / targets:** compiler `analysis/{check,resolve,types,effects,examples}.rs`, `codegen/{ir,js,defaults,artifact}.rs`; Contracts artifact/state descriptors. **Needs:** BGI-01 typed roles, BGI-02 association and BGI-04 saved snapshots.

**Change:** admit owner-scoped contributions through normal analysis, specialize named trait applications without AI and preserve source order. Emit canonical schemas/interfaces/imported wrapper joins and only declared ABI roles. Derive effects/control/service references, rather than runtime self-registration or a second authored interface manifest.

**Done when:** model fields/rules/hooks and field constraints/defaults reach ordinary consumers; incompatible kinds, duplicate/contradictory additions, sibling fields from field traits and unauthorized operations/grants refuse. No module runs to discover schema. Declared-role/import/result descriptors are sufficient for each runtime/UI consumer. Reuse affected compiler binding/codegen/typed-artifact cases; ordinary migration ownership remains unchanged.

### BGI-08 — Generated Given/When runtime and sequential effects

**Owner / targets:** Cloudflare `runtime/{modules,context,executors,invoke}.ts`; State `invocation/{registry,invoke}.ts`, `effects/staging.ts` and existing canonical producers; existing Values codecs. **Needs:** BGI-07 checked server exports/effect descriptors. Implementation can begin against BGI-01's agreed shape before those producer cases finish.

**Change:** attach declared run/default/check exports to existing owners; supply narrow canonical effects, exact codecs and admitted record handles. Enforce active-call/closed-scope/failure rules, staged read/write order, final result checking, single commit and replay.

**Done when:** independently authored cases cover pure default/rule behavior, ordered read-after-write, exact input/result rejection, overlap/pending/late calls, caught canonical failure, permission refusal, conflict/business rollback and replay without rerunning JS. Reuse native-local-rules, typed-scenario-values and scenario-framework-effects fixtures. No host context/store is passed through; trusted JS is not qualified as a sandbox.

### BGI-09 — Row-bound renderers and browser controls

**Owner / targets:** compiler view lowering and Contracts presentation descriptors; UI `components.ts`, `forms.ts`, `client.ts`, `browser/bootstrap.ts`; Interfaces `http/{presentation,form-binding,prepared-validation,operations}.ts`; Cloudflare page/module join. **Needs:** BGI-01/02 checked row/control descriptors and saved export lookup. Consume BGI-07 contributions only where a row model requires them.

**Change:** generated render/helper and optional mount/cleanup joins, one row argument evaluation, separate instance identity and compiler-owned canonical controls. No broader props/slots/exports. Preserve authorized data, typed fields, versions/CSRF, pending state, validation/drafts and focus behavior.

**Done when:** repeated row-bound instances render and submit declared controls; refused fields are absent; validation retains drafts/focus; replaced instances clean up mounts. Reuse `view_reuse.rs`, UI generated-form/client/lifecycle cases and actual browser fixtures. Existing canonical HTTP controls retain admission ownership.

### BGI-10 — Scoped CSS and DOM hooks

**Owner / targets:** compiler CSS parsing/scoping beside codegen, typed style descriptors; UI semantic factories/root/part hooks and browser styles. **Needs:** BGI-01 style ownership/use descriptors and BGI-02 unit IDs/assets; BGI-09 root hooks only for generated-view integration cases.

**Change:** choose/pin a maintained CSS parser for deterministic ordinary checks; enforce ownership per selector compound, supported nesting/conditions, child-host rules, local keyframes/properties and owned URLs. Reject accepted exclusions. Walk checked view/trait uses for inspection, without a persistent new index.

**Done when:** ordinary and directly edited styles pass the same parsing/scoping path; local/nested/reusable cases show guarded selectors, namespacing, inheritance/placement and blocked child-interior/global/URL escapes. Semantic components keep canonical controls and no compulsory wrapper. A two-style fixture can change one scope while the other's files remain unchanged.

### BGI-11 — Target validation, maps and zero-AI saved build

**Owner / targets:** compiler `cli.rs`, `source.rs`, `codegen/{mod,artifact,sourcemap}.rs`; Cloudflare `deploy/{bundle,module-imports,module-maps,package-assets}.ts` and existing actual-target fixtures. **Needs:** BGI-04 snapshots plus the relevant BGI-07/08/09/10 output for the selected unit kind, not completion of every kind.

**Change:** one finite validator dispatch by kind/target, checked closure packing, workerd/browser separation, current-JS maps plus Can owner links, and deterministic build/check/bundle consumption. Validation binds to captured inputs/current bytes; source/interface drift permits deterministic manual adoption.

**Done when:** the affected unit's declared exports/imports/assets and target behavior qualify; missing/incompatible inputs diagnose; saved edited code rebuilds from a clean checkout without coding CLI/login/model calls. Maps locate actual saved JS. Source/process/filesystem APIs never enter worker/browser bundles. Reuse unchanged per-kind results; add a small harness only for a demonstrated missing case.

### BGI-12 — Join validation, acceptance and recovery controls

**Owner / targets:** Node generation dispatcher/lifecycle with BGI-04 promotion; compiler inspection/check integration. **Needs:** BGI-03/05 operations, BGI-04 promotion and BGI-11 applicable validator.

**Change:** complete doctor/status/inspect/bind/diff, generate/refine/accept composition, validate/adopt, retry/resume/cancel/reset, rollback and edit/lease recovery. Each control uses the single existing producer mechanism rather than duplicating it.

**Done when:** the structured agent workflow reaches distinct candidate/accepted outcomes; matching source/current bytes/fence controls promotion, conflicts preserve candidates, compatible direct edits need no adoption ceremony, and explicit repaired-source adoption needs no AI. Batches enumerate independent outcomes. Reuse BGI-04/05 recovery/fencing checks; add only the actual validation-to-promotion join cases.

### BGI-13 — Finite end-to-end acceptance and documentation

**Owner / targets:** existing compiler/Cloudflare/UI fixtures, `examples/Todo.can` only when integration is ready, grammar/design/help and the accepted requirements. **Needs:** applicable completed task outputs and real-provider gates for their observations.

**Change:** execute the requirements' 12 finite scenarios, linking their existing owner results rather than rebuilding proof packets. Complete an agent-only Todo workflow and a clean-checkout saved build. Record scoped results/gaps in this plan and the decision log; keep accepted requirement boundaries intact.

**Done when:** all scenario observations have relevant implementation evidence, including all four available/authenticated runners, row-bound controls, selective style changes, participating edits, journal recovery and request replay. Existing checks are reused unless a changed seam invalidates them. An external gate stays explicitly open rather than being disguised as completed acceptance.

## Dependency order and milestones

1. **Foundation:** BGI-01 → BGI-02. After the descriptor/group handoffs, BGI-03 and BGI-04 can proceed independently.
2. **Parallel implementation:** BGI-05 → BGI-06 in tooling; BGI-07 → BGI-08 in compiler/runtime. BGI-09 and BGI-10 can start from their exact contract/identity handoffs. A consumer needing generated trait fields waits for those checked contributions, not all runtime work.
3. **First complete slice:** BGI-10 style output + BGI-05 Codex execution + BGI-04 promotion + the style-specific BGI-11 validator/build → BGI-12 selected-style control flow. Generate one Todo style unit, accept it and rebuild with zero AI; keep a sibling unit intact.
4. **Complete initial scope:** join Given/When and row-bound view/browser outputs through the same BGI-11/12 pipeline; finish all four adapters and BGI-13 acceptance. The style milestone is progress, not closure of the four-category requirement.

Dispatch at most three independent implementation lanes with exact file ownership. Grammar/descriptor changes precede their consumers; shared `ir.rs`, `js.rs`, Contracts and CLI joins are serialized or handed off. Capture-sensitive runs use fixed snapshots, and parallel workers must not mutate the consumed producer/output closure. No unrelated programme's whole parent plan is a prerequisite.

## Requirement and scenario coverage

| Requirement | Defining tasks |
| --- | --- |
| BGEN 01–02 | BGI-01, BGI-07, BGI-09, BGI-10 |
| BGEN 03–04 | BGI-03, BGI-05, BGI-06 |
| BGEN 05–06 | BGI-02, BGI-04, BGI-11 |
| BGEN 07–09 | BGI-02, BGI-04, BGI-05, BGI-10, BGI-12 |
| BGEN 10 | BGI-04, BGI-12 |
| BGEN 11–12 | BGI-07, BGI-08, BGI-09, BGI-10, BGI-11 |
| BGEN 13 | BGI-02, BGI-05, BGI-11 |
| BGEN 14–15 | BGI-03, BGI-04, BGI-05, BGI-06, BGI-12 |

BGI-13 consumes all 12 canonical scenarios without duplicating their owner tasks. Task closure is at its stated scope; update this one execution view with concise changed-behavior results. Do not create reviews of reviews, hash-manifest chains or repeated unchanged qualification.

## External gates and stopping conditions

- **Per-runner executable/auth/model:** operator and provider own installed availability, native login and supported model. Release each gate with successful doctor and one bounded authenticated generation through that adapter. Record actual reported identity or honest unknowns. Continue pure/simulated/saved-build work while a gate is held.
- **Target runtimes:** the relevant environment owns the selected workerd/browser availability. Release with the applicable actual-target case; Node syntax/import success does not close that case. Continue unaffected tasks.
- **Filesystem support:** BGI-04 owns qualification of its platform's coordination/durability primitives. Unsupported guarantees diagnose; this does not authorize weakening the accepted write protocol or claiming universal CAS.
- **Start coding:** this turn adopts requirements and produces the plan. Source implementation begins on the human's subsequent instruction. Optional API runners, broader component APIs, global CSS/font generation and GUI tooling remain outside scope.

No merge occurred. The repository's complete living file-tree checkpoint stays unchanged; the eventual merge handler reconciles accumulated changes under the existing rule. This feature plan does not reopen unrelated accepted criteria or take ownership of other in-flight source edits.
