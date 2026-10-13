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

## Current corpus result, 2026-10-13

The frozen-snapshot baseline covers **50 app groups, 57 app declarations, 122 authored pages, 100 literal prompts, 119 named uses, 576 example tables and 2,425 example rows**, plus three shared sources. These are lexical inventory counts. The baseline compiler reports **862 diagnostics, complete=true, omitted=0**; prompt `$` syntax is among the failures. All 50 draft source groups fail the current single-app dev-profile admission because they use explicit packages/composition. The [corpus report](../output/draft-frontends/corpus/index.html) records exact inputs and source-specific reasons.

Two confirmed source defects were subsequently fixed: CanDiscover's `Evidence.create` hook now adjusts the pending `event.after` record, and CanPromptLab's explicit archive-attribution field is `archive_recorded_at`, avoiding reserved storage metadata. Six PromptLab source/witness files stay consistent and retain handwritten provenance. A focused four-source check is complete with zero omitted diagnostics and no `E4052`/`E5008`; 112 other diagnostics remain, including 34 prompt-carrier failures. This closes those two corrections only; the full corpus report remains the retained pre-fix baseline.

The actual [ModelFreePreview capture](../output/draft-frontends/model-free-preview/report.html) and [HelpOffice capture](../output/draft-frontends/help-office/report.html) pass desktop/mobile browser audits. HelpOffice executes four current authored example rows: all pass, none are unsupported. Source/build identities remain current through capture, and owned endpoints are released. Assistant inspection finds legible, aligned, responsive resting/empty states; populated, loading, validation and interactive states remain uninspected. The screenshots exercise standard shipped styling, not generated prompts.

These browser runs use a frozen temporary compiler/package snapshot with Node 24. The [runtime snapshot note](../output/draft-frontends/runtime-snapshot.json) identifies the committed Interfaces baseline used instead of concurrent unfinished Interfaces edits. The full HelpOffice functional qualification did not complete and remains open in its [existing result](../output/draft-frontends/help-office-functional.json); four source examples and screenshots do not close that broader scope. Script syntax and repository package-boundary checks pass (zero violations).

The next required producer changes are the existing BGI syntax/generation/intake/runtime work and dev-server support for a selected app's package/import closure and actual resource bindings. Removing admission checks or rewriting drafts into reduced sample apps would not satisfy those outcomes. All-draft style generation, browser journeys and visual acceptance remain open.
