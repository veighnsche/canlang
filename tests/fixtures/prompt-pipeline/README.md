# Prompt pipeline fixture

`PromptStudio.can` covers named and inline traits, a reusable standalone canonical-identity keyword, component styles and a row-bound renderer with canonical controls. Ordinary When behavior stays authored Can. Generated files live beside the app under `can.generated/`.

The current source declares each action as an individual `primary` or `secondary`
primitive, with explicit text and target:

```can
primary "Edit item" action=Item.update arguments={record=row} fields=title,handle
secondary "Archive item" action=Item.delete arguments={record=row}
secondary "Open notes" target="/notes"
```

Shared UI owns the visible primary button design and the secondary overflow menu.
Input and confirmation controls retain canonical dialogs, permission checks,
protected bindings and mutations. ItemTile declares a canonical card in source;
its generated renderer receives one opaque `bindings.card`, including all content
and controls. Can supplies its surface, heading menu and primary footer. A view,
tooltip or layout wrapper cannot independently own primary/secondary actions.

The app exercises Create in its page toolbar, Edit in each card footer, and
Archive plus navigation behind the header menu. Playwright checks compact menus,
multiple entries, keyboard dismissal and focus, cancellation, validation,
mutation/readback, desktop/mobile layout, title width and content/action cohesion.
The `/actions` page also exercises list/table row placement, modal/drawer/detail
heading menus and footers, and an explicit inline form submit. The allowed owner
matrix lives in [UI components](../../../docs/design/UI-COMPONENTS.md).
The current owner gate (`.can/gen/checks/run-source-action-owners-20261014-mount/report.json`, local run output)
passed compilation, build, seven examples and the complete Playwright journey on
14 October 2026 (67.0 seconds, no skipped/flaky tests). Native Can accepted the
retained generated candidate. Its 18 captures include `/actions` and `/split`;
the browser receipt records eight navigations and a closed owned session.

Generation is explicit and uses the committed `can.gen.toml`: Codex, `gpt-6.1-sol`, medium reasoning, one bounded attempt per job. Playwright opens the real protected dev preview and consumes saved outputs; it never invokes AI generation.

The app-local `playwright.config.ts` owns the browser journey. Candidate acceptance
sets `CAN_ACCEPTANCE_SOURCE` to the absolute scratch `PromptStudio.can` path,
`CAN_ACCEPTANCE_WORKSPACE` to the installed workspace root, and
`CAN_ACCEPTANCE_OUTPUT` to its private browser output directory. The same journey
then consumes candidate generated files beside that scratch source and stores
screenshots under the private output directory. The root
`playwright.prompts.config.ts` reuses this configuration for ordinary saved runs.
The shared protected-dev-session helper also enforces the candidate source when
these variables are set. After verifying the serving identity and releasing its
owned session, it writes `browser-session.json` with the absolute source,
source revision, serving build, a positive `browserNavigations` count and
`closed:true`. It records each owned server in `browser-owner-*.json` at startup
so the outer gate can stop it even if Playwright is interrupted. The gate requires
this receipt alongside a passing Playwright report. Browser tests using another
helper must provide the equivalent current candidate session receipt.

Seven authored Alias create examples exercise trimmed stored spelling, empty-input
validation, member permission, NFKC and ASCII case uniqueness, successful distinct
keys and preserved non-ASCII case. Generated trait defaults and constraints remain
covered by the real browser journey.

From the repository root, prepare the installed producers and compiler using the commands in [developer setup](../../../docs/dev-setup.md):

```sh
bun install --frozen-lockfile
bun run build
bun run catalog
bun run build:compiler
```

Use the owning `build` commands rather than incremental `build:emit` for a dev
capture; the dev server checks that the installed producer outputs are current.
If a fresh checkout reports that the Values binding predates its Rust sources,
run `bun run build:values-wasm`, rebuild Values, and emit its catalog. This local
native rebuild does not invoke a coding agent.

Add the native compiler to this shell's PATH after building, then run the app directly:

```sh
export PATH="$PWD/compiler/target/debug:$PATH"
cd tests/fixtures/prompt-pipeline
can gen PromptStudio.can --dry-run
can gen PromptStudio.can
can validate PromptStudio.can
```

The same commands accept `tests/fixtures/prompt-pipeline/PromptStudio.can` from
the repository root. Can discovers the installed platform automatically. No
fixture script, JSON request or explicit Node command is needed. The existing
platform runtime remains an internal dependency.

Generation uses a natively authenticated Codex CLI. If the supported client is
not the executable on PATH, select its absolute path with
`export CAN_CODEX_BIN=/absolute/path/to/codex`. The committed app-local recipe
requests `gpt-6.1-sol` with medium reasoning for every prompt category; Can never
substitutes another model. `--dry-run` shows the effective recipes and selected
units without starting a coding agent.

`can gen PromptStudio.can` prepares missing or changed output, checks the complete
candidate app and atomically accepts it only after compilation, build, all seven
Can examples and the app-local Playwright journey pass. Existing current files
survive any failure. If every saved unit is fresh, it runs those same checks
without AI or promotion. `can validate PromptStudio.can` explicitly checks the
saved app without AI. Reports and candidate screenshots stay in `.can/gen/checks/`.
Use `--format=json` for a machine-readable result.

The earlier native CLI run on 14 October accepted all eight generated units after
the full gate passed. A subsequent accepted view-only generation used a compact,
initially collapsed Archive disclosure, with keyboard opening and cancellation
covered by that browser journey. The historical disclosure gate report (`.can/gen/checks/run-source-293dae9c-247f-4cd4-adc4-255d8d5dccbc/report.json`, local run output)
and nine historical disclosure screenshots (`.can/gen/checks/run-source-293dae9c-247f-4cd4-adc4-255d8d5dccbc/1/screenshots/`, local run output)
remain beside the app; the execution view records the checks and recovery.

To regenerate every prompt, including successful styles and views:

```sh
can gen PromptStudio.can --retry
```

The implementation's separate fault-injection integration lives in
`verify-acceptance.mjs`; it is an internal test of rejection and recovery, not the
app-generation entry point. Its retained results are linked from the
[current execution view](../../../docs/design/proposals/build-generation/implementation-plan.md#current-codex-integration-execution-view--2026-10-13).

Saved JavaScript and CSS remain directly editable through the generation edit-lease controls. For a compatible CSS edit, send these version-1 requests to `compiler/target/debug/can gen` on stdin, using the low-level automation interface:

1. Use `status` with `root` equal to this fixture's absolute directory and `files:["PromptStudio.can"]` to identify the owning style unit.
2. Send `edit.begin` for the exact existing CSS path. Retain its returned token and confirm `state:"editing"` before writing.

```json
{"version":1,"request_id":"css-edit-begin-1","operation":"edit.begin","root":"/absolute/project/tests/fixtures/prompt-pipeline","paths":["can.generated/STYLE_UNIT_ID/style.css"]}
```

3. Edit only that CSS file, then release in a `finally` path even if the write fails:

```json
{"version":1,"request_id":"css-edit-end-1","operation":"edit.end","root":"/absolute/project/tests/fixtures/prompt-pipeline","token":"TOKEN_FROM_EDIT_BEGIN"}
```

4. Confirm `state:"released"`, then validate the owning unit with no AI:

```json
{"version":1,"request_id":"css-edit-validate-1","operation":"validate","root":"/absolute/project/tests/fixtures/prompt-pipeline","unit_id":"STYLE_UNIT_ID"}
```

A valid low-level unit result has `state:"validated"` and passing static checks.
That JSON operation checks one unit only. Run `can validate PromptStudio.can`
after direct edits to check the full app, examples and browser behavior.
Compatible saved-code edits need no adoption ceremony.

The integration run generated and atomically accepted all eight units with the
requested Codex `gpt-6.1-sol` / medium recipe, then completed a full retry with the
same unit identities. Saved prepare reused and validated all eight units with
`CAN_CODEX_BIN=/nonexistent/codex`. A lease-coordinated CSS edit also validated
without AI. The bounded native and generation reports are linked from the
[current execution record](../../../docs/design/proposals/build-generation/implementation-plan.md#current-codex-integration-execution-view--2026-10-13).

Historical real dev-server Playwright acceptance passed (1 test, 54.7 seconds) with
`CAN_CODEX_BIN=/nonexistent/codex`. That run verified authenticated create/update/archive,
archived-key retention, duplicate errors and retained form values, trimmed fields,
both generated false defaults, keyword reuse and Unicode behavior, repeated mounts,
and all three pages. Each capture checks the current source/build and horizontal
overflow; the journey asserts no browser errors and releases its dev session.

Run screenshots remain local under ignored `playwright/screenshots/` or the acceptance output directory. Regenerate them with `can validate PromptStudio.can`; they are not approved reference images and are not checked into Git.

The standalone [action gallery](../action-gallery/README.md) and
[forms app](../action-forms/README.md) expose every admitted action owner using
shared defaults, with 88 additional desktop/mobile inspection captures and no
generated styling. Captures support human inspection; they are not automatically
approved visual references.

Transient failure artifacts stay under ignored `output/prompt-pipeline/playwright/`.
This fixture does not establish acceptance for the other draft apps or their design
references; no reference images were generated here.
