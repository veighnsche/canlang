# Draft frontend validation

Use the actual compiler, protected `can dev` preview, app authentication and browser controls. A source inventory, handwritten `can.generated` witness, successful HTTP response or screenshot alone does not establish a working application.

The requested generation model is **Codex 6.1 Sol (`gpt-6.1-sol`), medium reasoning**, for styles, components, traits and custom keywords. This is a requested recipe, not a generation receipt. The build-generation engine and its MCP output boundary remain owned by the existing [BGI-01–13 implementation plan](../design/proposals/build-generation/implementation-plan.md). Do not duplicate that engine plan or substitute manually written CSS for a successful prompt-generation test.

The [draft frontend implementation plan](../implementation/draft-frontends/PLAN.md) defines DFE-01–07 for source correctness, composed-app preview, resource joins, real generation adoption, functional journeys, visual acceptance and corpus rollout. It consumes BGI and existing dev/runtime handoffs without reopening their accepted scopes. CanTable is the first complete domain-app target; CanPromptLab separately proves every generation form.

## Inventory and compiler check

```sh
bun run audit:draft-frontends --out output/draft-frontends/corpus
```

This discovers `draft/apps/*/*.can` and shared sources, lists every app declaration, authored page, prompt, scenario, query, handler, CRUD declaration and example table, then runs one bounded corpus analysis. `audit.json` preserves returned diagnostics, completeness, omitted counts, source identities and the actual dev-profile admission verdict. `index.html` provides the app matrix. Lexical counts do not establish compiler semantics or per-app dependency membership. The corpus includes alternative compositions and therefore is not a selected-app compilation.

The full audit exits **1 while end-to-end acceptance is absent**, or 2 for a compiler tool failure. `--inventory-only` exits 0 after writing an explicitly unqualified inventory. A compiler/source freshness failure, changed input or incomplete/mismatched diagnostic response cannot qualify a run. Re-running replaces only the report files in the requested output directory.

## Capture a real preview

Build the compiler and the required package outputs, then refresh the catalog before capture: `bun run build:compiler`, `bun run build --filter=@canlang/cloudflare --filter=@canlang/testkit`, and `bun run catalog`. Keep their consumed source/output closure fixed during a run; use a separate checkout or frozen snapshot if another worker is editing it. Do not disable freshness checks.

```sh
bun run capture:dev-frontend \
  --source compiler/tests/fixtures/construct-help-first-profile.can \
  --app HelpOffice --route / --examples \
  --out output/draft-frontends/help-office
```

The command creates a dev session, checks its source, waits for its current preview, signs in as a real seeded local member, selects the member's actual team, and captures the requested routes at 1440×1000 and 390×844. Add `--route /another-page` for every required route. A route defaulting to `/` does not mean all pages were tested. Use explicit `--session ID` to attach to an existing session; the command stops only a session it created.

`--examples` invokes the existing source-example runner. It requires a current matching build, nonzero executed cases and a passing result. It does not substitute for a browser journey. The browser report checks HTTP/resource failures, console/page errors, horizontal overflow, visible control labels and image loading/alt attributes. It saves PNGs plus `report.json` and `report.html`, without login credentials, cookies or preview bootstrap tokens. Exit 0 means the requested smoke checks passed; visual approval and complete functionality remain separate.

## Acceptance for each selected app

| Concern | Required observable outcome |
| --- | --- |
| Source and composition | The original selected app and its derived dependency closure compile completely. Preserve permissions, examples and business intent; classify unsupported language features separately from actual draft mistakes. |
| Prompt generation | The real runner records the requested model/effort and receives the complete active Then context. Given contributions precede their consumers. Generated outputs arrive through the accepted MCP contract, validate and render. Named reuse and a saved rebuild require no model call; full retry includes every active prompt. Reuse BGI owner results. |
| Functionality | Each requirement and authored operation has a concrete allowed path and relevant denied/invalid path. Exercise actual forms and canonical operations, reload persistence, validation recovery, cross-team isolation, stale updates/replay, and app-specific asynchronous/file/external-provider behavior where declared. External provider gates stay named and open. |
| Examples | Execute the selected app's authored rows against the admitted runtime. Zero, skipped, unsupported and setup-failed rows cannot pass. |
| Visual quality | Inspect every page's desktop/mobile images with representative content and its meaningful empty, populated, validation, loading and failure states. Check hierarchy, spacing, typography, contrast, keyboard focus, long text, usable forms and image layout against the actual style prompt. Check declared theme/locale variants. |
| Regression | Keep an approved screenshot only after visual inspection; compare later captures using stable data and matching viewport/theme/locale. Investigate differences instead of automatically accepting a new baseline. |

Record a concise result against the owning requirement and reuse it while its inputs remain unchanged. Screenshot smoke checks deliberately do not click every control indiscriminately: app-specific expectations and permission boundaries belong in the existing Playwright journeys and runtime tests. Generated trait success does not close custom-keyword semantics, and one fixture does not close the draft corpus.

## App-local Playwright suites

Each of the 50 app folders has its own `playwright.config.ts`, `playwright/app.spec.ts` and `playwright/README.md`. There are 127 concrete journey bodies and 108 current reference mappings. The entry owns its browser assertions; its README distinguishes authored bodies from remaining workflow, role, data and resource requirements. Shared code lives in `tests/e2e/drafts/`, with an independent root `playwright.drafts.config.ts`. Run from the Can repository root with built compiler/runtime/catalog inputs and installed Chromium:

```sh
bun run typecheck:draft
bun run test:draft -- --list
bun run test:draft:coverage
bun run test:draft -- CanTable/playwright/app.spec.ts
bun run test:draft -- CanTable/playwright/app.spec.ts --project=desktop
node node_modules/@playwright/test/cli.js test --config=draft/apps/CanTable/playwright.config.ts
```

The four projects check declared coverage, execute source examples, and run desktop/mobile browser cases. Runs are serial, with no automatic retries or snapshot updates. Each runtime case creates an owned dev session, pins source/revision/build, uses actual local Identity cookies, and stops that session. Credentials stay outside Playwright tracing; trace/video capture is disabled. An existing session is not silently attached or stopped. `DRAFT_E2E_ROOT` can select an isolated runtime checkout containing the same original draft paths; captured results remain beside the app's test entry.

Source discovery supplies provisional app compositions, static routes, operations, example counts and companion requirement candidates. It distinguishes explicit page composition from symbol imports. Dynamic routes require real records created by a journey; literal `{Record.id}` URLs are never used. Examples must execute the complete selected candidate denominator with zero failed/setup-failed/unsupported rows. Disagreement with compiler membership requires investigation, not a smaller passing denominator. Compiler-qualified closure remains a runtime prerequisite: this lexical intake cannot prove semantic membership or complete understanding of prose requirements.

The coverage project writes missing operations, companion requirements, state candidates and permitted page identities into each app's `playwright/results/coverage/`. Missing bodies are failures rather than skipped or passing placeholders. Generic state candidates are a minimum intake aid: the owning journey must still exercise each applicable control and outcome. A source example is an isolated canonical-operation check; its rows do not seed the serving browser, and it does not prove that a UI control works. The new bodies cover only their explicit outcomes. All 57 selections still have incomplete coverage.

Add normal Playwright assertions to the app entry through `defineDraftAppSuite`'s `journeys` option. Each journey names its app selection when necessary, seeded actor, covered operation/requirement IDs, and route/state pairs. Its `run` callback receives `page`, `context`, the actual `session`, `baseURL` and `capture(route, state, referenceFilename?)`. Declare coverage only for outcomes the body actually asserts; every declared state must produce a capture. Use real canonical forms and genuine business-role/domain fixtures. The default Ava membership has no custom business-role grants, so it cannot satisfy a host/curator workflow. Role/data provisioning is still a DFE-02/03 handoff, not something a test may simulate by changing the DOM.

Guarded initial pages use explicit `pageActors: [{ route, actor }]` for a genuinely provisioned permitted identity. That actor is separate from Ava's non-role denial cases. `unauthenticated: true` gives a journey preview transport access without an application Identity session; ordinary HTML requests can recover to sign-in, while explicit JSON requests retain canonical refusal envelopes. Denied JSON captures have no permitted-page concept equivalent and are inspected separately. Declared validation journeys allow expected 400/422 canonical operation responses; unrelated HTTP/resource/console failures remain failures.

Candidate acceptance uses `CAN_ACCEPTANCE_SOURCE` and `CAN_ACCEPTANCE_WORKSPACE` for runtime and source discovery. It preserves the app's authored companion requirements; tests cannot accidentally certify only the old working source. The app-local configs run coverage, examples and both browser viewports, never update baselines automatically, and retain diagnostics when any gate fails.

## References, captures and forgiving visual review

The separate image agent owns `playwright/references/` inside each app. These are intended designs, not runtime screenshots. Keep its default maximum of five concepts per app, allowing more for additional distinct pages. One concept can guide several states; screenshot coverage is not limited to five. Tests do not generate images.

An app can explicitly map a concept with `references: [{ route: "/cafe", file: "02-host-queue-desktop.png" }]` in its suite options. Optional `state` and `viewport` narrow the mapping; a more specific mapping wins. A journey can supply an exact filename to `capture`. Without a mapping, the helper looks for `<route>-<state>-<viewport>.png`; other images are displayed as unassigned concepts, never silently treated as equivalent states. A desktop concept can guide hierarchy at mobile size, while actual regression baselines always remain separate by viewport and app selection.

Every capture writes an actual PNG, accessibility snapshot, metadata and a self-contained side-by-side HTML report under the app's `playwright/results/<selection>/`. Reports include the image agent's README and prompt notes. Flag material deviations: missing actions or content, overlapping/clipped controls, unreadable hierarchy or contrast, wrong major layout and broken responsive flow. Allow small spacing, font rendering, antialiasing and sample-content differences. The source owns functionality; invented image controls and omitted required fields are defects in the concept, not instructions to change the app. Concepts are never compared with browser screenshots using strict pixel equality.

After inspecting a real capture against its concept and functional result, retain it at the baseline path in the metadata. Record the inspection in the adjacent `.approved.json` with `reviewer`, ISO `approvedAt`, `baselineSha256` (the metadata's `actualSha256` for a new baseline) and `referenceSha256`. This records inspection, not a separate permission request; the reviewer may be the implementing agent. The one record binds the reviewed baseline and concept bytes so replacing either cannot silently preserve acceptance. Do not manufacture an inspection record for an unseen screenshot.

Subsequent Playwright regression comparisons use `threshold: 0.25` and `maxDiffPixelRatio: 0.02`, with animations disabled. This allows minor rendering noise; significant changes still need inspection. Missing references, unmapped concepts and uninspected baselines produce reports with `pending-review` and fail visual acceptance. A passing baseline comparison establishes regression stability, not complete functional or conceptual correctness. App-local references and baselines are versioned; generated results and root HTML/JSON reports are ignored.

## Current corpus result, 2026-10-13

The [current rollout record](../implementation/draft-frontends/PLAN.md#current-rollout-result--13-october-2026) supersedes the historical counts below: 50 local configs, 127 concrete journeys, 108 reference mappings and 828 discovered cases. Both typechecks pass; all 57 declared-coverage cases still fail, with no skips. Current corpus analysis has 394 diagnostics and every original selection remains outside the composed preview profile. No complete original draft or screenshot/reference comparison is accepted. The record links the exact readiness, coverage and real shared-session results; the retained earlier evidence below is not a new assignment or a claim of current acceptance.

The frozen-snapshot baseline covers **50 app groups, 57 app declarations, 122 authored pages, 100 literal prompts, 119 named uses, 576 example tables and 2,425 example rows**, plus three shared sources. These are lexical inventory counts. The baseline compiler reports **862 diagnostics, complete=true, omitted=0**; prompt `$` syntax is among the failures. All 50 draft source groups fail the current single-app dev-profile admission because they use explicit packages/composition. The corpus report (`../output/draft-frontends/corpus/index.html`, local run output) records exact inputs and source-specific reasons.

Two confirmed source defects were subsequently fixed: CanDiscover's `Evidence.create` hook now adjusts the pending `event.after` record, and CanPromptLab's explicit archive-attribution field is `archive_recorded_at`, avoiding reserved storage metadata. Six PromptLab source/witness files stay consistent and retain handwritten provenance. A focused four-source check is complete with zero omitted diagnostics and no `E4052`/`E5008`; 112 other diagnostics remain, including 34 prompt-carrier failures. This closes those two corrections only; the full corpus report remains the retained pre-fix baseline.

The actual ModelFreePreview capture (`../output/draft-frontends/model-free-preview/report.html`, local run output) and HelpOffice capture (`../output/draft-frontends/help-office/report.html`, local run output) pass desktop/mobile browser audits. HelpOffice executes four current authored example rows: all pass, none are unsupported. Source/build identities remain current through capture, and owned endpoints are released. Assistant inspection finds legible, aligned, responsive resting/empty states; populated, loading, validation and interactive states remain uninspected. The screenshots exercise standard shipped styling, not generated prompts.

These browser runs use a frozen temporary compiler/package snapshot with Node 24. The runtime snapshot note (`../output/draft-frontends/runtime-snapshot.json`, local run output) identifies the committed Interfaces baseline used instead of concurrent unfinished Interfaces edits. The full HelpOffice functional qualification did not complete and remains open in its existing result (`../output/draft-frontends/help-office-functional.json`, local run output); four source examples and screenshots do not close that broader scope. Script syntax and repository package-boundary checks pass (zero violations).

The next required producer changes are the existing BGI syntax/generation/intake/runtime work and dev-server support for a selected app's package/import closure and actual resource bindings. Removing admission checks or rewriting drafts into reduced sample apps would not satisfy those outcomes. All-draft style generation, browser journeys and visual acceptance remain open.

Playwright setup verification on the current checkout: both the existing E2E typecheck and dedicated draft typecheck pass. Discovery lists 526 cases across 50 local entry files (57 coverage, 57 example, 206 desktop and 206 mobile cases); these are discovered cases, not executed app acceptance. All 57 coverage checks fail for missing semantic journeys/states, with no missing local package owners after distinguishing builtin `std` and nested compositions. The original CanTable desktop attempt fails `PROFILE_UNSUPPORTED` before rendering. Explicit concept mappings currently cover 46 routes in 36 app folders; the other image/page mappings remain pending the image agent's files or exact route notes.

The new visual helper passes a direct Chromium fixture check for pending capture/report output, an inspected matching baseline and a material mismatch with retained comparison report. This uses controlled HTML only and makes no draft-layout claim. Real-session qualification exposed two installed bundle omissions: `env-assembly.js` consumed unstaged `export-downloads.js`, and that module's `canonicalJson` import was absent from the existing HTTP facade. The focused repair stages the existing module and exports its existing owning function; it changes no permissions or operation semantics. Cloudflare rebuild and the relevant existing bundle-closure and D1-boot tests pass.

After that repair, the new session helper signs in through actual Identity and captures ModelFreePreview (`../output/draft-frontends/playwright-harness/model-free.png`, local run output) with HTTP 200, visible canonical main/CSS and unchanged serving identity. Inspection confirms the intended heading/text, sidebar and authenticated avatar. It also runs all four HelpOffice example rows (`../output/draft-frontends/playwright-harness/help-office-examples.json`, local run output), with zero failures, setup failures or unsupported rows and a matching source/build tuple. Owned sessions/browser resources close successfully. These results qualify the shared harness on supported fixtures; they do not close any original draft's functional or visual acceptance. The separate reference-image agent's concurrent source/image edits are outside this change's ownership.

## Retained development preview data

The installed `can-dev` owner retains its real Identity database and the separate
Cedar/Oak State databases across preview replacement, `stop`/`start` and process
restart. Storage defaults to `~/.local/state/canlang/preview`; set
`CAN_DEV_STATE_ROOT` to an owner-only directory on retained Project storage when
running in a Project container. Its source directory is keyed by canonical
project root and source path. Metadata contains development actor credentials,
so directories require mode 0700 and metadata requires mode 0600. Credentials
remain available only through the existing owner-only `preview.open` protocol.
The protected bridge and application login remain required after restart.

Typed File fields remain supported by the current local Files receiver and the
compiler-selected implicit `FILES` R2 binding. Source-declared local R2, KV,
Durable Objects and analytics storage use paths under the same preview state
root; retaining D1 does not remove those current runtime bindings. The Soda
target separately enforces its HTTPS Files grant requirements.

Ordinary page and operation edits reuse the same data. A change to the compiled
model descriptors or global/team ownership refuses the retained preview until
migration support exists; use a separate `CAN_DEV_STATE_ROOT` to try a changed
schema without discarding existing data. To reset data deliberately, stop the
owning session, inspect that root's `preview.json` source identity, then remove
only its identified source directory. Incomplete Identity provisioning also
refuses instead of replacing saved data. Required retained storage must remain
writable; runtime startup never substitutes ephemeral D1 for that binding.
A refused owner `check` returns `preview=build_failed` and bounded
`preview_error` explaining the actual host failure.

Source examples still run in the existing disposable per-run fixture databases;
example changes never populate or mutate the serving preview. The existing draft
browser test helper selects its own private per-session state and temporary root
and cleans it after verified owner shutdown, keeping those fixtures separate
from a developer’s retained preview. Qualification
builders also remain disposable unless their trusted host explicitly supplies a
retained root. Development credentials and state are not production identity,
backup or migration qualification.

Run the focused actual HTTP/restart/example check after building the compiler
and installed packages:

```sh
node scripts/verify-preview-persistence.mjs \
  --compiler "$PWD/compiler/target/release/can" \
  --state "$PWD/.artifacts/preview-persistence"
```

For a fresh installed Project, add `--project-root /home/USER/PROJECT` and
`--tool-root /home/USER/TOOLS`, selecting its shipped compiler with `--compiler`.
The command creates its finite `.artifacts/preview-persistence-input/Preview.can`
witness, executes two compiled examples, writes and reads through actual
application HTTP operations, and stops only the sessions it starts. State and
credential-bearing metadata stay in the selected task-owned state root; the
printed result contains no credentials.
