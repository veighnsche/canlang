# Draft frontend validation

Use the actual compiler, protected `can dev` preview, app authentication and browser controls. A source inventory, handwritten `can.generated` witness, successful HTTP response or screenshot alone does not establish a working application.

The requested generation model is **Codex 6.1 Sol (`gpt-6.1-sol`), medium reasoning**, for styles, components, traits and custom keywords. This is a requested recipe, not a generation receipt. The build-generation engine and its MCP output boundary remain owned by the existing [BGI-01–13 implementation plan](design/proposals/build-generation/implementation-plan.md). Do not duplicate that engine plan or substitute manually written CSS for a successful prompt-generation test.

The [draft frontend implementation plan](implementation/REMAINING-WORK.md#draft-frontend-acceptance) defines DFE-01–07 for source correctness, composed-app preview, resource joins, real generation adoption, functional journeys, visual acceptance and corpus rollout. It consumes BGI and existing dev/runtime handoffs without reopening their accepted scopes. CanTable is the first complete domain-app target; CanPromptLab separately proves every generation form.

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
bun run test:draft -- CanTable/playwright/app.spec.ts
bun run test:draft -- CanTable/playwright/app.spec.ts --project=desktop
node node_modules/@playwright/test/cli.js test --config=draft/apps/CanTable/playwright.config.ts
```

The projects execute source examples and desktop/mobile browser cases. Runs are serial, with no automatic retries or snapshot updates. Each runtime case creates an owned dev session, pins source/revision/build, uses actual local Identity cookies, and stops that session. Credentials stay outside Playwright tracing; trace/video capture is disabled. An existing session is not silently attached or stopped. `DRAFT_E2E_ROOT` can select an isolated runtime checkout containing the same original draft paths; captured results remain beside the app's test entry.

Source discovery supplies provisional app compositions, static routes, operations, example counts and companion requirement candidates. It distinguishes explicit page composition from symbol imports. Dynamic routes require real records created by a journey; literal `{Record.id}` URLs are never used. Examples must execute the complete selected candidate denominator with zero failed/setup-failed/unsupported rows. Disagreement with compiler membership requires investigation, not a smaller passing denominator. Compiler-qualified closure remains a runtime prerequisite: this lexical intake cannot prove semantic membership or complete understanding of prose requirements.

Use app requirements to select meaningful browser assertions. Source discovery helps find routes and operations, but lexical inventories do not decide whether a journey is implemented or correct. A source example checks canonical operations in isolation and does not establish that a UI control works.

Add normal Playwright assertions through `defineDraftAppSuite`'s `journeys` option. Each journey selects its app, seeded actor and real route/state. Its callback receives `page`, `context`, the actual `session`, `baseURL` and `capture(route, state, referenceFilename?)`. Optional requirement and operation annotations help readers understand intent; they do not replace assertions. Use genuine role and domain fixtures: changing the DOM cannot supply missing business grants.

Guarded initial pages use explicit `pageActors: [{ route, actor }]` for a genuinely provisioned permitted identity. That actor is separate from Ava's non-role denial cases. `unauthenticated: true` gives a journey preview transport access without an application Identity session; ordinary HTML requests can recover to sign-in, while explicit JSON requests retain canonical refusal envelopes. Denied JSON captures have no permitted-page concept equivalent and are inspected separately. Declared validation journeys allow expected 400/422 canonical operation responses; unrelated HTTP/resource/console failures remain failures.

Candidate acceptance uses `CAN_ACCEPTANCE_SOURCE` and `CAN_ACCEPTANCE_WORKSPACE` for runtime and source discovery. It preserves the app's authored companion requirements; tests cannot accidentally certify only the old working source. The app-local configs run examples and both browser viewports, never update baselines automatically, and retain diagnostics when any gate fails.

## References, captures and forgiving visual review

The separate image agent owns `playwright/references/` inside each app. These are intended designs, not runtime screenshots. Keep its default maximum of five concepts per app, allowing more for additional distinct pages. One concept can guide several states; screenshot coverage is not limited to five. Tests do not generate images.

An app can explicitly map a concept with `references: [{ route: "/cafe", file: "02-host-queue-desktop.png" }]` in its suite options. Optional `state` and `viewport` narrow the mapping; a more specific mapping wins. A journey can supply an exact filename to `capture`. Without a mapping, the helper looks for `<route>-<state>-<viewport>.png`; other images are displayed as unassigned concepts, never silently treated as equivalent states. A desktop concept can guide hierarchy at mobile size, while actual regression baselines always remain separate by viewport and app selection.

Every capture writes an actual PNG, accessibility snapshot, metadata and a self-contained side-by-side HTML report under the app's `playwright/results/<selection>/`. Reports include the image agent's README and prompt notes. Flag material deviations: missing actions or content, overlapping/clipped controls, unreadable hierarchy or contrast, wrong major layout and broken responsive flow. Allow small spacing, font rendering, antialiasing and sample-content differences. The source owns functionality; invented image controls and omitted required fields are defects in the concept, not instructions to change the app. Concepts are never compared with browser screenshots using strict pixel equality.

Inspect captures when visual behavior matters. Use an ordinary Playwright screenshot baseline for useful regression coverage, and update it after understanding a material change. Concept references and review notes are optional aids; no adjacent approval file or hash record is required.

Subsequent Playwright regression comparisons use `threshold: 0.25` and `maxDiffPixelRatio: 0.02`, with animations disabled. This allows minor rendering noise; significant changes still need inspection. A passing baseline comparison establishes regression stability, not complete functional or conceptual correctness. App-local references and baselines are versioned; generated results and root HTML/JSON reports are ignored.

## Current limitations

The [remaining-work list](implementation/REMAINING-WORK.md#draft-frontend-acceptance) describes missing source, composed-preview, provider and original-app behavior. Historical inventory counts and screenshot reports do not establish current application support. Run the selected affected journey with its actual compiler, runtime, actors and resources, and report concrete failures.
