# Services and build-time generation

Connect typed external behavior to business workflows, and use explicit generation to create saved implementations for selected source declarations.

## Two different uses of AI

An application can call a model provider as part of its business workflow: classify an incoming document, propose a reply or answer an authorized question. That is runtime service behavior with inputs, outputs, permission checks and delivery outcomes.

Build-time generation instead creates application implementation from authored intent. A style prompt describes appearance; a trait prompt describes a checked contribution. Generation writes saved output through the host's accepted submission boundary. Running the finished application does not rerun those build-time prompts.

## Model integrations as typed business work

Declare capabilities, typed contracts and the selected deployment binding. Call the supported service through a scenario with explicit inputs, and retain the output or receipt your workflow needs. A declaration or provider name does not supply credentials or silently authorize a transfer.

For external delivery, separate the database decision from dispatch and provider observation. Handle a known failure differently from an uncertain outcome. Preserve durable request identity when reconciling an earlier attempt. A retry must not charge, notify or submit twice just because the first response was lost.

Knowledge-backed answers use an authorized model-bound corpus: declare which records supply content and enforce current permissions when retrieving and using them. A search hit is not a new grant. Keep approval or review explicit when model output changes consequential business state.

## Add generation intent to source

These are illustrative declaration fragments, not a complete app. A reusable model or field trait belongs in `Given`:

```can
trait NamedContact $"Add a normalized display name and require it to be nonempty."
```

A reusable named style belongs in `Then`:

```can
style Calm $"Use a clear, compact business layout with readable spacing."
```

Generation slots use static `$"..."` strings. The dollar marker is adjacent to the JSON string; it is not runtime interpolation. Named styles apply with a `$Name` suffix on a component. Views declare their typed row binding and renderer prompt. Named standalone custom keywords have typed compile-time signatures and checked integration contracts; they are distinct from traits.

Ordinary `When` scenarios retain authored guards and `do` bodies. A prompt does not replace an operation's business authority. Generated contributions cannot grant permissions or bypass storage and transaction owners.

## Configure and inspect generation

Place `can.gen.toml` at the app root, or pass `--settings=PATH`. This example recipe uses an installed Codex client with native login:

```toml
version = 1
[generation]
runner = "codex"
model = "gpt-6.1-sol"
max_attempts = 1
timeout_seconds = 600
[generation.native]
model_reasoning_effort = "medium"
```

Select a runner and model that your installed client actually supports. `CAN_CODEX_BIN` can select an absolute executable path. This recipe uses the client's authentication; do not invent an API key requirement. Shared generation settings and frontend profiles can supply distinct complete recipes.

From the source workspace, the committed PromptStudio example demonstrates the workflow:

```sh
can gen tests/fixtures/prompt-pipeline/PromptStudio.can --dry-run
can gen tests/fixtures/prompt-pipeline/PromptStudio.can
can validate tests/fixtures/prompt-pipeline/PromptStudio.can
```

Dry-run inspects preparation without acceptance. Generation requires the configured client and can incur its usage. Validation checks saved output without AI. Your app needs executable examples, its own Playwright configuration and installed browser dependencies for the full acceptance workflow.

## Keep working output reviewable

The host validates a captured candidate through compilation, build, compiled examples and the app's browser checks before promotion. Failed or changed inputs preserve current saved files. Reports and screenshots remain in the app's `.can/gen/checks/` directory.

Default generation reuses fresh saved units; `--retry` deliberately regenerates all selected prompt units. Inspect status and repair associations when declarations move or prompts change. Do not overwrite generated metadata to suppress a freshness failure. [CLI reference](../04-Reference/01-cli.md) describes the status and validation commands.
