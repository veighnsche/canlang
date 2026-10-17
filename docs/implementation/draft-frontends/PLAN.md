# Draft frontend implementation plan

Status: **partial implementation, 13 October 2026.** The user authorized app-local Playwright setup and reference comparisons; a separate agent owns reference-image generation. The user requires every draft app to work through the real dev server, look good, and have functional and screenshot evidence. Generated styles, components, traits and custom-keyword logic must use **Codex GPT-6.1 Sol (`gpt-6.1-sol`) at medium reasoning**.

This is the current execution view for draft adoption and frontend acceptance, with IDs **DFE-01–07**. The [BGI-01–13 plan](../../design/proposals/build-generation/implementation-plan.md) remains the sole execution view for the generation engine. The [dev-server plan](../can-dev-server/PLAN.md) and its linked Compiler, Capability and Packages assignments retain their existing owners and accepted results. A dependency here requires its named output, not completion of that owner's whole programme. This plan does not restart the stopped dev-server programme or reassign the separately authorized BGI implementer.

## Starting point

| Evidence already available | Scope retained |
| --- | --- |
| Corpus audit (`../../../output/draft-frontends/corpus/index.html`, local run output) and [validation runbook](../../draft-frontend-validation.md) | 50 source groups, 57 app declarations, 122 authored pages, 100 literal prompts, 119 named uses and 2,425 example rows. These are lexical counts; selected-app closures and route membership still need compiler output. |
| Complete baseline analysis | 862 diagnostics, zero omitted. This predates the two focused source corrections; it is not 862 independent bugs. Unsupported prompt syntax causes cascading failures. |
| CanDiscover pending-record and CanPromptLab archive-field corrections | The two specific diagnostics are absent in the complete focused check. Their app workflows remain unqualified. |
| ModelFreePreview and HelpOffice captures | Four inspected desktop/mobile resting-state images using shipped styling; four HelpOffice example rows pass. These qualify neither a draft app nor generated styles. The later broad HelpOffice attempt did not complete. |
| Existing dev T00–T13 and G1/G2 | Original Office acceptance stays closed at its recorded frozen inputs. Its separate G3/A7 unfamiliar-agent benchmark is externally held and is not a prerequisite here. |

The current dev admission profile rejects explicit packages, imports, `app … uses=` and multiple app declarations. Every draft source group uses packages/composition. The BGI execution view now records actual PromptStudio generation and candidate compile/build/native/Playwright acceptance. The draft apps still retain 100 legacy handwritten saved-unit records without real generation provenance; those records are not compatible with current saved-unit intake. No complete draft frontend is accepted by this validation work yet.

## Delivery order

| Milestone | Required handoff | Observable result |
| --- | --- | --- |
| 1. Generation foundation | Existing BGI style-first milestone: descriptors/intake, Codex/MCP, snapshot/promotion, scoped CSS and applicable target validation | The existing Todo fixture proves genuine named/inline styling, full retry and a saved rebuild with zero model calls. This remains a BGI result, not draft acceptance. |
| 2. First complete domain app | DFE-01–06 for **CanTable**, consuming only its required BGI and compiler/runtime outputs | The original `/cafe` app works through authenticated dev preview, passes its examples and reservation/seating journeys, and has inspected desktop/mobile images. |
| 3. Every generation category | DFE-01–06 for **CanPromptLab**, adding BGI-07/08/09 | All styles, views, named/inline model and field traits, and the distinct named custom keyword run together with actual Sol-medium provenance. Three routes, functionality and images pass. |
| 4. Corpus rollout | Repeat the same acceptance work over the remaining selections as their precise dependencies become ready | Every authored app selection has a passing result or a named unresolved requirement. Shared mechanisms are qualified once; composition-specific behavior is still checked. |
| 5. Maintainable regression check | DFE-07 | One command reports complete coverage, functional results and visual changes; CI exercises accepted saved output without spending model calls. |

CanTable is a useful first domain app because it has one page, one inline style prompt, shared location/employee imports and no external provider dependency. It still needs its actual policies, relational queries, preferences and operations; it is not a reduced CRUD rewrite. CanPromptLab is the existing all-form showcase added to the corpus: one package, no imports, 20 prompt groups and three routes. Its novel keyword needs the State producer, so its full acceptance must not block a style-only app. CanDo follows its actual federated-work dependencies and generated view; its familiar name does not make it a small first slice.

## Tasks

### DFE-01 — Map requirements and correct the original sources

**Status:** planned; reuse the existing inventory and two accepted corrections.

**Owner / files:** draft integration owner; `scripts/audit-draft-frontends.mjs`, `draft/apps/*/*.can`, adjacent requirement companions and `draft/shared/`. Compiler defects remain with the defining Compiler task.

**Prerequisite output:** current source inventory and companion requirements for the selected batch. Semantic closure checks additionally need the relevant compiler/BGI-01 output; initial requirement mapping can start immediately.

**Change:** connect each selected app's requirements, routes, operations, examples and declared resources to its existing tests or a concrete missing journey. Once source carriers are supported, compile each selected app closure and classify failures as source mistakes, missing compiler/runtime capability, missing generation, or missing binding. Fix demonstrated source mistakes without erasing intent, weakening permissions or replacing the original app. Record an actual ambiguity as the exact decision needed. A difficult new design choice follows the repository's three-request JEV policy; this ordering of accepted work needs no new architecture consultation.

**Done when:** every selection in the batch has complete, source-current analysis and a requirement-to-test/result mapping. Each demonstrated source defect is corrected with its focused check, or remains explicitly open. Undefined/unsupported behavior cannot count as a successful check. Reuse shared rows and their evidence across consumers; do not create a second authored app registry or one ticket per cascading diagnostic.

### DFE-02 — Serve a selected composed app in the dev server

**Status:** planned.

**Owner / files:** Cloudflare dev owner in `packages/cloudflare/src/dev/`, native CLI selection in `compiler/src/cli.rs`, existing `tests/integration/can-dev-server/` consumers. Reuse T01/T06/T08/T09 and the existing owner-only controls.

**Prerequisite output:** compiler-owned selected app/package/import closure, ordinary artifact/page contracts, and BGI-02/04 saved-input and reader/promotion handoffs for generated files. Ordinary composition work can proceed before live generation.

**Change:** expose explicit selection of an authored app through the existing CLI/control protocol; reject ambiguous selection. Derive the full required source and accepted generated contribution/module/CSS/asset closure from owning declarations and compiler output. Capture and watch that closure, including additions/removals, against one revision. Feed its actual artifact into the protected preview. Rebuild on relevant source or accepted-output edits; preserve the working preview and identify its revision while a candidate fails or awaits acceptance. Keep session ownership, isolation, error redaction and bounded cleanup.

**Done when:** the original CanTable sources plus their genuine shared dependencies serve `/cafe`; source, imported-source and accepted-style edits update the correct preview revision. Ambiguous selection, missing dependency, stale build and failed promotion remain explicit; unrelated app edits do not invalidate a closure that does not consume them. Auth, required assets and owned stop work. Later batches add only demonstrated closure cases. Deleting admission checks or passing an incomplete root file does not close this task.

### DFE-03 — Join each app's required resources and runtime owners

**Status:** planned, assessed per selected app; independent ready apps continue.

**Owner / files:** existing Compiler, State, Values, Interfaces, UI, Files, Work, Capability and Cloudflare owners, linked through the [existing platform handoffs](../can-dev-server/PLAN.md#prioritized-existing-platform-handoffs). DFE owns the draft consumer, not a duplicate implementation of their mechanisms.

**Prerequisite output:** DFE-01's exact requirement/resource inventory and the checked compiler artifact. Request the specific missing descriptor, owner port, binding or lifecycle outcome from its defining task.

**Change:** install the declared local D1/Identity, file/image, query, event, schedule, provider and configured-route resources actually consumed by that app. Reuse qualified owner outputs. For example, configured Files/export routes consume OUT-R05/S9-Q08 and DEL-B02; provider/ingress joins consume TECH-I01/I02; Chat/Creative callback predicates consume SEQ-025. Preserve their existing finite scopes and holds. Do not create a permissive resource whitelist, fabricate authority or label a provider double as a live provider result.

**Done when:** every required resource in the selected closure has an actual admitted local/target binding and its declared success, refusal, failure and recovery behavior is observed at the draft consumer. A provider contract test may pass independently while the named live-provider journey remains held. Required human/external releases remain visible with owner and release condition; they do not block unrelated apps or authorize production deployment.

### DFE-04 — Generate and adopt real Sol-medium draft output

**Status:** planned; generation implementation stays under BGI.

**Owner / files:** BGI owners supply the engine; draft integration owns `draft/can.gen.toml`, source-compatible saved groups and their adoption. Preserve handwritten witness provenance until genuinely replaced through the accepted lifecycle.

**Prerequisite output:** BGI-01/02/03/04/05/10 plus applicable BGI-11/12 outputs for styles. Views additionally need BGI-09; traits and custom keywords need their respective BGI-07/08 outputs. Consume these handoffs separately rather than wait for all of BGI-13 or the other CLI adapters.

**Change:** replace illustrative recipe placeholders with the validated Codex configuration requesting `gpt-6.1-sol` and medium for every effective recipe, including the showcase's explicit `careful` profile. Inspect effective settings and actual producer evidence; report unavailable or unverified settings instead of silently substituting. Run the actual CLI with protected source/current/candidate roots unwritable by the generator. Supply whole active Then context and checked component/theme contracts; admit Given contributions before their frontend consumers. Submit all generated content through host-owned MCP targets, validate it and accept the complete candidate set. Reconcile provisional associations conservatively; retain direct edits and prior working output until acceptance.

**Done when:** actual requested-model output serves in the selected draft, each required output kind has truthful provenance, and the relevant BGI owner results cover named reuse, zero-AI saved builds, full-app retry including already successful prompts, and failure/cancel/conflict preservation. CanPromptLab separately passes named/inline model traits, named/inline field traits, views and its genuinely novel named keyword. No inline keyword or generated When body is introduced. A pure handwritten helper check or a passing trait is not keyword acceptance.

### DFE-05 — Execute complete functional journeys

**Status:** partial implementation. All 50 app groups now have local configs, entries and 127 concrete journey bodies: source-specific permitted/denied access, fresh-store views and reloads, saved preferences, incomplete-input refusal and CanApprove validation/create/readback. All 57 coverage checks still fail for listed unmet workflows/states and permitted identities; these bodies are authored, not accepted app executions. Real business-role/serving-data provisioning and composed preview remain prerequisites. The actual CanTable attempt fails `PROFILE_UNSUPPORTED` before capture. See the current rollout result below; source examples and initial-page checks cannot close this task.

The shared session helper is qualified on actual ModelFreePreview authentication/rendering/capture and all four HelpOffice example rows, with matching source/build identity and owned cleanup. Two concrete preview bundle omissions were fixed in the existing Cloudflare owner: stage `export-downloads.js` and expose its existing `canonicalJson` dependency through the HTTP facade. This restores the ordinary preview seam and does not implement composed-app support.

**Owner / files:** `draft/apps/*/playwright/app.spec.ts` and adjacent journey notes, shared `tests/e2e/drafts/` session/suite helpers, and owning runtime/example tests. Use the existing Playwright dependency and owner-only dev protocol.

**Prerequisite output:** DFE-01 coverage for the app; current DFE-02 preview, relevant DFE-03 resources and accepted DFE-04 outputs. Journey authoring can start earlier from the source requirements.

**Change:** drive real authenticated browser controls through the actual dev server, with isolated stores, deterministic representative data and the source's actual roles. Run authored examples with complete denominators. Connect each requirement/operation to its allowed outcome and relevant denied/invalid outcome; include persistence after reload, validation recovery, canonical mutation/readback, stale updates, replay and atomic failure where the workflow declares them. Exercise API/MCP-only behavior through its canonical interface instead of adding UI solely to test it. External effects use isolated test accounts/endpoints where available and keep live-provider claims separate.

**Done when:** every requirement in the selected batch has its expected outcome observed; all applicable authored rows execute with zero failures, skips or unsupported rows. A legitimately example-free declaration uses explicit journey coverage and is reported as such, not as an example pass. Each declared UI control is covered in its meaningful state; hidden/denied controls cannot bypass authority through direct calls. Browser requests, resources and console have no unexplained failures. Reuse existing owner edge-case tests and add only the missing draft integration observations.

**First finite journeys:** CanTable covers host versus member/location authority; waiting/reserved/seated/cleared states; overlapping reservations, invalid party/time values and occupied-table refusal; explicit clearing, cancellation reasons, filters/preferences and reload. CanPromptLab consumes the exact fixtures in its [companion](../../../draft/apps/CanPromptLab/CanPromptLab.md): archive/restore attribution, notes, UTF-8 and EAN-13 validation, canonical-key collisions/scopes, atomic swap/rollback, removal/replay and collision-checked activation. Keep those canonical fixture expectations in their owner rather than copy another checklist here.

### DFE-06 — Inspect prompt fidelity, images and responsive quality

**Status:** partial setup. The app specs now map 108 current reference concepts to source routes. App-local capture/accessibility/side-by-side reports and tolerant inspected-baseline regression checks are implemented. A direct Chromium helper qualification passes pending capture, matching baseline and material mismatch reporting; it qualifies the helper only. No original draft capture or visual acceptance is claimed. A separate agent supplies app-local reference concepts; this implementation generates none.

**Owner / files:** UI/draft quality owner; source style/view prompts and generated editable outputs; app-local `playwright/references/`, `playwright/baselines/` and ignored `playwright/results/`; shared `tests/e2e/drafts/visual.ts`.

**Prerequisite output:** current DFE-05 setup and meaningful browser states. Capture only after consumed source, runtime outputs, catalog and accepted generated groups are fixed.

**Change:** capture every admitted route at the existing 1440×1000 and 390×844 viewports, with representative content and the relevant empty, populated, validation, loading and failure states. Cover declared locale/theme variants; use long labels/content and keyboard navigation. Inspect each image against its actual prompt: hierarchy, readable typography, consistent spacing, useful emphasis, unclipped controls, focus, contrast and mobile reflow. Test canonical pending/errors and permissions while styles/views are mounted. Correct source intent when needed and use the requested model for generated style/component fixes through the same acceptance lifecycle.

Image-bearing apps additionally use genuine admitted test image files through their File/upload/gallery paths: preview, aspect ratio/cropping, alt text, load failure and revoked access where declared. Include their real media layouts in screenshots. An image-free fixture cannot satisfy image functionality; nonvisual file formats retain their own workflow checks.

**Done when:** every required route/state has an inspected, satisfactory image and its corresponding functional assertions pass. Record a short prompt-specific visual verdict and any defect beside the capture; smoke checks or pixel similarity alone cannot approve appearance. Only inspected captures become regression baselines. Later comparisons use matching state, viewport, locale and theme; intentional changes receive inspection rather than automatic baseline replacement. Reuse identical shared-component states, while still visiting each composed route to catch integration/layout defects.

### DFE-07 — Roll out the corpus and keep the result repeatable

**Status:** partial rollout. All 50 app-local `playwright.config.ts` files are compatible with candidate acceptance; the shared suite consumes candidate source bytes while retaining authored companion requirements. `test:draft`, `test:draft:coverage` and `typecheck:draft` discover 828 cases across 50 entries. Coverage still fails for every selection, and no saved-output CI acceptance is claimed. Existing DFE-01–06 gaps remain prerequisites for acceptance, not prerequisites for adding the local test files.

**Owner / files:** draft integration owner; existing audit/capture scripts, Playwright config/specs, appropriate existing CI workflow and [runbook](../../draft-frontend-validation.md).

**Prerequisite output:** the first accepted DFE-01–06 app, then each ready batch. This task consumes their results and does not review their reviews or create a second evidence system.

**Change:** add one documented command that selects authored apps, runs their saved-output functional/visual checks and emits the coverage summary using existing reports. Derive selection/routes from checked source rather than a parallel app manifest; test-specific fixture data and expected outcomes remain in the owning tests. CI validates accepted saved output without model calls. Real generation is a separate explicit, bounded qualification run after relevant prompt/generator changes. Publish screenshots and diffs as test artifacts, with missing/stale/held coverage clearly distinct from passes.

**Done when:** all current source groups and selected app declarations are accounted for, every required journey and route/state passes, and no required binding/provider/visual gate remains unreported. Shared package examples and generator mechanisms are counted once and linked to every consumer; composed apps still exercise their own routing, authority and layout joins. A new app, route or requirement causes an explicit coverage gap until added. Full acceptance is withheld while any required row is failed, unsupported, uninspected or externally held. Changed inputs rerun only affected checks; unchanged acceptance is reused.

## Current rollout result — 13 October 2026

The readiness result (`../../../output/draft-frontends/rollout-readiness.json`, local run output) replaces the old diagnostic counts for this rollout: all 57 selections are outside current composed-preview admission; corpus analysis returns 394 diagnostics, complete with none omitted. CanTable plus authentic Employee/Location sources passes analysis but native compilation reports 41 emission failures (40 E6008, one E6007), including scoped query/control and imported derive/hook lowering. These are operand-closure failures, not proof every imported declaration belongs to the minimal selected closure. CanPromptLab has 61 analysis diagnostics rooted in field-trait parsing and missing generated bindings. Compiler owns those fixes and selected dependency closure; Dev owns composed capture and genuine serving actor/record provisioning. Merely removing admission is insufficient.

The coverage run (`../../../output/draft-frontends/rollout-coverage.json`, local run output) executed all 57 lexical coverage cases: 57 fail, zero skipped/flaky. Each app's `playwright/results/coverage/` names missing operations, companion requirements, states and permitted page actors. Counts shared across alternative compositions are not additional canonical assignments. Both E2E typechecks and diff checks pass; discovery (`../../../output/draft-frontends/rollout-discovery.json`, local run output) lists 828 cases, not 828 successful executions. Candidate-overlay discovery preserves companion requirements and substitutes candidate routes; private `.can` directories are excluded from source discovery.

The real shared-session check (`../../../output/draft-frontends/rollout-harness/report.json`, local run output) passes anonymous direct JSON refusal, actual HTML sign-in recovery without an Identity cookie, member HTTP200 rendering, currentness and owned cleanup. Its initial 403-for-HTML assumption was corrected against actual authentication behavior; similarly new app tests use canonical validation rather than nonexistent native-required/email widget behavior. Custom-role denied actors remain distinct from explicit permitted `pageActors`. This qualifies the changed helper only. No original draft screenshot/reference comparison or complete workflow is accepted; those remain DFE-02–06 gates. No reference images, generated implementations or production data were changed in this rollout.

### Action primitive rollout — 14 October 2026

**Explicit-owner correction, 14 October:** all 50 sources now contain 681
priorities (526 primary, 155 secondary) under the declared owner matrix. Eighteen
tooltip wrappers no longer own actions; useful localized explanations remain in
the same row/card scope. Fieldset submits move to their form footer, modal/drawer
controls to `slot actions`, and generated views declare whole canonical cards.
Existing read/result workflows retain canonical forms; ordinary dropdown triggers
retain ordinary checked buttons. Meaningful cards establish ownership within
otherwise unsupported visual scopes, preserving captions, aliases and guards.

The current whole-corpus check (`../../../output/draft-frontends/action-owners-check.json`, local run output)
completed all 53 app/shared sources with no omitted diagnostics and no action-owner
admission diagnostics. It still reports 399 diagnostics for the recorded broader
compiler/composition gaps. Two description-placement errors were repaired; a
previously masked nullable-person diagnostic in CanReception became visible.
This source check does not claim successful compilation, generation, browser
acceptance or reference comparison of the complete corpus. The native working
app owner-variant browser check is recorded once in the BGI execution view.


DFE-01's source migration is complete at its defined scope: all 50 app files now
contain **539 primary and 162 secondary individual labeled actions**. Bare
priority suites were removed; targets, localized labels and required row bindings
are explicit. Canonical inline, result-owning, import/review and dynamic forms
remain complete forms. Given/When and the indentation of surviving source
statements are preserved, including CanRent availability guards. New lexical
state discovery retains operation validation/pending/success and adds secondary
menu-open and explicit panel-open states; its focused direct test passes.

Native generation plans (`../../../output/draft-frontends/action-primitives-plans.json`, local run output)
resolve all 50 source files with `--settings=draft/can.gen.toml`: all 95 discovered
units request `gpt-6.1-sol` / medium, with zero model jobs during planning. This
qualifies recipe selection, not generation. Explicit shared settings are now an
ordinary `can gen FILE.can --settings=PATH` option; no ancestor search is added.

The current native whole-corpus check (`../../../output/draft-frontends/action-primitives-check.json`, local run output)
contains all 53 app/shared sources, is complete with zero omitted diagnostics,
and reports **400 diagnostics**. New migration/control-owner errors found during
integration were fixed. Remaining failures include missing generated
contributions, existing type and scoped-row gaps, and unsupported native
contracts; they are not 400 independent rollout tasks. CanTable with its genuine
Employees/Locations operands has **36 emission diagnostics** (35 E6008, one
E6007), including filter declarations, membership-dependent predicates and
imported hooks. The compile result (`../../../output/draft-frontends/action-primitives-table-compile.json`, local run output)
records those exact operands; it does not establish a minimal selected closure.

A real native CanTable generation attempt (`../../../output/draft-frontends/action-primitives-table-generation.json`, local run output)
used Sol 6.1/medium and produced a candidate. Its acceptance gate rejected it at
compilation because the source workflow omitted the imported source closure;
31 diagnostics name the missing providers and dependent names. Current generated
output was preserved. Do not spend calls regenerating every remaining app against
this shared unresolved prerequisite. **DFE-02 remains open:** Compiler must supply
checked selected-app/import closure; BGI acceptance and Dev must capture/compile
that same closure and preserve app selection. Removing the one-file admission
check does not satisfy this requirement. The independent complete-operand
emission failures above also remain with their existing Compiler owners.

The refreshed Playwright coverage run (`../../../output/draft-frontends/action-primitives-coverage.json`, local run output)
executes all 57 selections: 57 fail their explicitly missing workflow/state/actor
coverage, with no skips or flaky cases. App-local configurations/tests and existing
reference mappings remain present for all 50 apps. No original draft browser
journey or reference-image comparison is credited by this rollout. DFE-04–06 stay
open for those outcomes. The BGI execution view separately records real native
PromptStudio acceptance of the shared action implementation; it cannot substitute
for draft acceptance. No reference images were generated or replaced.

## Rollout batches

These cover the retained lexical baseline exactly once. They are scheduling groups, not independent deployment units or new runtime profiles. Dependency-ready apps may advance ahead of their batch; a needed imported operation requires its defining output, not completion of a neighboring batch. DFE-01 replaces lexical assumptions with selected-app membership before capture.

| Batch | Source groups (all names prefixed `Can`) | Groups / app declarations / authored pages |
| --- | --- | --- |
| Generation showcase | PromptLab | 1 / 1 / 3 |
| Domain screens; Table first | Table, Board, Feedback, Learn, Trade | 5 / 5 / 9 |
| People and approvals | Onboard, Expense, Grant, Approve, Hire | 5 / 6 / 14 |
| Commercial and workspace | Customer, Rent, Member, Invoice, Propose, CRM, Book, Reception, Event, Mail, Success, Loyalty, Refer, Affiliate | 14 / 18 / 48 |
| Operational work | Maintain, Field, Stock, Purchase, Time, Leave, Shift, Volunteer, Do, Desk, Contract | 11 / 13 / 22 |
| Adapters and automation | Catch, Check, Stats, Report, Sync, Enrich, Discover, Inbox, Workbench, Decide | 10 / 10 / 11 |
| Model content and media | Chat, Creative, Gallery, Knowledge | 4 / 4 / 15 |
| **Total** | **Every baseline source group** | **50 / 57 / 122** |

The 122 authored pages are not the final number of screenshots: states/variants expand it, and alternative compositions can reuse pages while requiring distinct integration checks. The 2,425 authored example rows are a retained source denominator, not a claim that they already execute or must be rerun once per importer.

## Dispatch, external gates and stopping

Use at most three independent implementation lanes, coordinating with existing workers:

1. **Generation owner lane:** existing BGI implementation and exact released handoffs; no competing implementation here. The engine implementer's model is separate from the user's required build-time Sol-medium producer.
2. **Dev integration lane:** DFE-02 and the specific DFE-03 consumer joins; serialize shared CLI/IR/Contracts changes with their owners.
3. **Draft acceptance lane:** DFE-01, recipes/adoption, app journeys and visuals. Prepare source expectations while waiting; run DFE-04–06 once their inputs are released, then finish DFE-07.

Before dispatch, name the app/requirement, owner, exact prerequisite output, remaining change and finite exit condition. Use an isolated checkout or fixed source/runtime snapshot during capture. No other worker may mutate its consumed producer/output closure until the owned preview and capture finish cleanup. Integrate coherent changes at a safe boundary; after a merge, reconcile the living file-tree plan under the repository rule. Planning alone advances no checkpoint.

| External condition | Owner / release condition | Work that can continue |
| --- | --- | --- |
| Actual Codex CLI supports/authenticates the requested model and medium setting | Operator/provider plus BGI-05; successful capability check and bounded authenticated MCP generation with actual producer/settings evidence. Desktop model availability alone is insufficient. | Syntax, saved intake, simulated runner checks, journeys and resource joins. |
| Enforced generator no-write boundary and supported filesystem coordination | BGI-04/05; actual adapter/host qualification. No direct-file fallback or weakened promotion. | Other owner outputs and ordinary saved builds. |
| App-specific provider credentials, ingress or deployment binding | Named resource owner/operator; release the exact isolated journey and required host binding. Existing held publication/activation actions retain their scope. | Local behavior, refusal paths, independent apps and clearly labelled provider contract tests. |
| Local workerd/Chromium or required test resources unavailable | Environment owner; actual target starts, admits required resources and cleans up. | Source checks and unaffected owner tests. |

Stop an app's acceptance task when its listed requirements pass and retain its result at those inputs. Keep a held app open with the exact failing/blocked requirement, owner and release condition; do not turn it into an unlimited platform obligation. The first implementation dispatch should produce the **CanTable prerequisite map and selected-app dev seam**, alongside the existing **BGI style-first handoff**. Its first user-visible finish line is a working, inspected `/cafe` frontend; final completion remains all selected drafts.
