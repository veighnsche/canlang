# Prompt pipeline fixture

`PromptStudio.can` covers named and inline traits, a reusable standalone canonical-identity keyword, component styles and a row-bound renderer with canonical controls. Ordinary When behavior stays authored Can. Generated files live beside the app under `can.generated/`.

Generation is explicit and uses the committed `can.gen.toml`: Codex, `gpt-6.1-sol`, medium reasoning, one bounded attempt per job. Playwright opens the real protected dev preview and consumes saved outputs; it never invokes AI generation.

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

Check the helper without making AI calls:

```sh
node tests/fixtures/prompt-pipeline/generate.mjs --help
node tests/fixtures/prompt-pipeline/generate.mjs --dry-run
```

Use Node 22 or newer and a natively authenticated Codex CLI. When the supported executable is the bundled current CLI rather than the one on PATH, select its absolute path explicitly:

```sh
export CAN_CODEX_BIN=/absolute/path/to/codex
node tests/fixtures/prompt-pipeline/generate.mjs
bunx playwright test --config=playwright.prompts.config.ts
```

The helper calls the public `compiler/target/debug/can gen` JSON interface. It resolves `CAN_PLATFORM_BIN` to the built workspace platform entry, keeps that child on the same Node runtime, and requests prepare, validation and complete-set acceptance. New candidates must be complete and accepted. When prepare skips every fresh saved unit and starts no job, the helper validates each reused unit without AI and records `reuse.validated=true`; it retains the host’s `accepted=false` because nothing new was promoted. Incomplete candidates and failed reuse checks report an error. Its summary report under `output/prompt-pipeline/` retains host outcome and attempt identifiers, excluding native diagnostics, prompts and credentials. The host keeps candidates and its normal recovery records under the fixture's `.can/gen/` directory.

For a fresh regeneration of every prompt in this app, including successful styles and views:

```sh
node tests/fixtures/prompt-pipeline/generate.mjs --retry
```

Saved JavaScript and CSS remain directly editable through the generation edit-lease controls. For a compatible CSS edit, send these version-1 requests to `compiler/target/debug/can gen` on stdin, with `CAN_PLATFORM_BIN` set to the built workspace `packages/cloudflare/dist/cli/platform.js` and the same Node runtime on PATH:

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

A valid result has `state:"validated"` and passing checks. Compatible saved-code edits need no adoption or acceptance call. Run Playwright or an ordinary build to consume the edited CSS.

The integration run generated and atomically accepted all eight units with the
requested Codex `gpt-6.1-sol` / medium recipe, then completed a full retry with the
same unit identities. Saved prepare reused and validated all eight units with
`CAN_CODEX_BIN=/nonexistent/codex`. A lease-coordinated CSS edit also validated
without AI. The bounded native and generation reports are linked from the
[current execution record](../../../design/proposals/build-generation/implementation-plan.md#current-codex-integration-execution-view--2026-10-13).

Real dev-server Playwright acceptance passed (1 test, 54.7 seconds) with
`CAN_CODEX_BIN=/nonexistent/codex`. It verifies authenticated create/update/archive,
archived-key retention, duplicate errors and retained form values, trimmed fields,
both generated false defaults, keyword reuse and Unicode behavior, repeated mounts,
and all three pages. Each capture checks the current source/build and horizontal
overflow; the journey asserts no browser errors and releases its dev session.

Eight inspected screenshots live beside this app:

- [Empty desktop](playwright/screenshots/01-empty-desktop.png)
- [Create drawer](playwright/screenshots/02-create-form.png)
- [Created item](playwright/screenshots/03-created-desktop.png)
- [Duplicate error](playwright/screenshots/04-duplicate-error.png)
- [Edited desktop](playwright/screenshots/05-edited-desktop.png)
- [Populated mobile](playwright/screenshots/06-populated-mobile.png)
- [Trait defaults](playwright/screenshots/07-trait-defaults.png)
- [Reused keyword](playwright/screenshots/08-reused-keyword.png)

Transient failure artifacts stay under ignored `output/prompt-pipeline/playwright/`.
This fixture does not establish acceptance for the other draft apps or their design
references; no reference images were generated here.
