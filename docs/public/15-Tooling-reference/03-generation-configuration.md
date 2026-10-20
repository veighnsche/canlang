# Generation configuration

Configure versioned project generation recipes, select explicit runner and model profiles, and keep machine authentication separate from committed application intent and prompts.

## Configuration shape

Project generation preferences live in version 1 `can.gen.toml`; machine authentication remains outside committed app intent.

The file is version 1 TOML with `[generation]` for the shared recipe and optional `[generation.profiles.NAME]` tables. Each named profile is a complete runner/model pair. Optional `max_attempts` and `timeout_seconds` limits reuse the shared limits when omitted; there is no inheritance graph. The limits are positive finite integers, and unknown keys/tables are rejected.

A profile’s native options belong only to that runner recipe. Given selects the shared recipe. Then selects the reserved `frontend` recipe when configured, otherwise shared. A declaration may name a logical profile; a run-level profile overrides it, then category default applies. Unknown explicit profiles are errors.

Explicit `--settings FILE` replaces the project-root file. Do not search ancestor, ambient user or local configuration. Runner override requires an explicit compatible model. Report effective values and their origins. Native adapter options remain tied to that recipe’s capability. Configuration changes affect future attempts only; they do not invalidate compatible saved implementation or cause ordinary builds to call a model.

## Separation of concerns

A compact shape is `version = 1`, followed by `[generation]` keys such as `runner`, `model`, `max_attempts` and `timeout_seconds`, then complete `[generation.profiles.frontend]` keys `runner` and `model`. Keep tool/model choices and limits here, prompts and application intent in `.can`, and login credentials in the machine’s native authentication store. Never commit API keys or copy them into generated files, browser output or candidate metadata. See [generation lifecycle](../03-Generate-implementation/01-generation-lifecycle.md).

## Complete configuration example

This settings example requires installed, authenticated runner CLIs and a compatible model ID chosen for each runner. Replace the illustrative model strings with those supported by that installation.

```toml
version = 1

[generation]
runner = "codex"
model = "your-compatible-model"
max_attempts = 1
timeout_seconds = 600

[generation.profiles.frontend]
runner = "codex"
model = "your-compatible-frontend-model"
```

Runner IDs are `codex`, `muse`, `claude-code` and `opencode`. Models are explicit nonempty strings. Built-in omitted limits are one attempt and 600 seconds; configured limits are integers from 1 through 4,294,967,295. Shared runner/model may be omitted in an unconfigured file, but execution must resolve both before launch. Named profiles must always contain both.

## Configure runner-specific options

Optional `[generation.native]` and `[generation.profiles.NAME.native]` tables contain only flat string/number/bool values. Profiles do not inherit shared native options. A run `native` map replaces the selected map entirely, with no merge. Native keys require support from that adapter; unsupported MCP transport, authentication, model, sandbox or permission controls produce actionable preflight errors and cannot silently select weaker permissions or a different tool. Only an implicit missing frontend default falls back to shared: explicit `agent=frontend` or run profile frontend must resolve an actual profile.

The pinned Codex recipe admits `native.model_reasoning_effort` as one of `low`, `medium`, `high`, `xhigh`, `max` or `ultra`; the selected CLI/model must support the choice. Other native keys require an explicitly documented adapter capability and fail preflight otherwise. `doctor` reports those capabilities, including whether custom MCP attachment, enforced write restriction and recorded-session resume are available. A recognized runner ID alone does not establish that the installed adapter can launch.
