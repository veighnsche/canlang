# CLI and language reference

Choose the command for the question you need to answer, and keep compiler diagnostics, application artifacts and runtime outcomes distinct.

## Compiler and authoring commands

Use the complete toolchain from [installation](../01-Getting-started/02-installation.md). It bundles the runtime, adapters and catalog, so the commands below work from your application folder without building CanLang.

| Command | Purpose |
| --- | --- |
| `can --version` | Report tool, commit, language and schema versions |
| `can check FILE.can...` | Analyze source names, types, rules and effects |
| `can compile FILE.can...` | Analyze and emit the compile artifact |
| `can fmt FILE.can` | Format the file in place |
| `can fmt --check FILE.can` | Report formatting differences without writing |
| `can lint FILE.can...` | Return recommendations after successful analysis |
| `can policy FILE.can...` | Inspect declared roles, policies and operation gates |
| `can explain E7004` | Explain a diagnostic code |
| `can lsp` | Serve the language protocol over standard input/output |
| `can help COMMAND` | Show command-specific compiler help |
| `can completions zsh` | Print a completion script; bash and fish also work |

`--format=json` supplies machine-readable output for check, compile, lint, explain and policy. Source analysis exits 0 on success, 10 when diagnostics report errors, and 2 for a tool or usage failure. Formatting differences also use exit 10. Inspect the actual command's contract for platform and generation outcomes.

A successful check does not assert that every runtime effect or generated UI profile emits. Compilation can return emission diagnostics instead of an artifact. Preserve completeness and omitted counts when a response includes them.

## Catalog discovery

The installed `can` launcher selects its bundled catalog automatically. Application authors do not need to generate a catalog or set `CAN_CATALOG`.

For compiler commands accepting a catalog, an explicit `--catalog=PATH` takes precedence over `CAN_CATALOG`, then `./can-catalog.json`, then `./packages/values/dist/catalog.json`. The standalone launcher supplies the `CAN_CATALOG` default. Generating a workspace catalog with `bun run catalog` is part of [optional contributor setup](../01-Getting-started/03-contributor-setup.md).

The language server loads its catalog at startup. It has no `--catalog` flag; use its process environment and workspace location, then restart after changes.

## Platform commands

| Command | Purpose |
| --- | --- |
| `can run --artifact PATH` | Assemble modules and report a local file entry |
| `can test --artifact PATH` | Execute compiled examples through installed Testkit |
| `can build --artifact PATH` | Validate and prepare the application build |
| `can deploy --artifact PATH --env NAME --preview` | Inspect a deployment plan |
| `can deploy --artifact PATH --env NAME --yes` | Prepare outputs and attempt remote apply |
| `can activate --artifact PATH --env NAME` | Evaluate the activation bundle |
| `can dev help` | List local session controls and their required flags |

These delegate to the matching runtime adapters already bundled with the standard installation. `CAN_PLATFORM_BIN` and `CAN_DEV_BIN` are optional overrides for contributor or custom toolchains, not application setup requirements. A missing adapter is `E7004`; check for an old compiler-only installation or stale overrides. Platform command arguments pass through, including `--help`; `can help deploy` shows the compiler-side delegation contract.

Follow [local development](../03-Build-and-operate/01-local-development.md) for real preview controls and [deployment](../03-Build-and-operate/03-deployment.md) for required sidecars and environment selection.

## Generation and saved-output validation

```sh
can gen App.can --dry-run
can gen App.can
can gen App.can --retry
can validate App.can
can gen status --format=json . App.can
```

`--retry` regenerates all selected units. `validate` uses saved output without AI. `gen status` inspects associations and freshness. Source generation accepts `--settings=PATH`; the default is the app root's `can.gen.toml`. The advanced `can gen --request FILE` interface consumes the versioned generation control request, including inspection, refinement, leases, adoption and rollback. Use the request's exact schema rather than inventing positional subcommands.

Generation control exits distinguish invalid configuration (2), conflict or held lease (3), validation failure (4), runner failure (5) and unknown completion (6), in addition to success (0). Resolve an uncertain completion before resubmitting external generation work.

## Generate an application reference

```sh
can docs Tasks.can --out reference.md
can docs Tasks.can --locale=nl --out reference.nl.md
```

The compiler extracts checked declarations; the matching platform renderer produces localized Markdown. Without `--out`, it writes Markdown to standard output. Without `--locale`, it uses the app default and source fallback. `--format=json` shapes diagnostics, not successful Markdown. This command does not run scenarios or examples and refuses to overwrite `.can` source.

## Language reference

The public handbook explains use; these canonical owners settle exact definitions:

- [Requirements](https://github.com/veighnsche/canlang/blob/main/docs/specification/REQUIREMENTS.md): product goals and scope.
- [Grammar](https://github.com/veighnsche/canlang/blob/main/docs/specification/GRAMMAR.md): exact syntax, layout and header options.
- [Language design](https://github.com/veighnsche/canlang/blob/main/docs/specification/DESIGN.md): semantics, defaults and authority.
- [Construct-help catalog](https://github.com/veighnsche/canlang/blob/main/docs/specification/CONSTRUCT-HELP.md): source-owned cards with stable identifiers and availability dimensions.
- [UI catalog](https://github.com/veighnsche/canlang/blob/main/packages/ui/src/catalog.ts): component profiles and binding options.
- [Values catalog](https://github.com/veighnsche/canlang/blob/main/packages/values/src/catalog.ts): builtin types and callable signatures.
- [Generation requirements](https://github.com/veighnsche/canlang/blob/main/docs/specification/BUILD_GENERATION_REQUIREMENTS.md): generated extension boundaries.

## Larger examples

The [TeamTasks source](https://github.com/veighnsche/canlang/blob/main/examples/TeamTasks.can) combines assignment, filtering, localization, inline examples and app composition. [ExpenseFlow](https://github.com/veighnsche/canlang/blob/main/examples/ExpenseFlow.can) adds reviewer roles, submission/approval rules and typed reports. Read them after the first Tasks app, then adapt their business rules with your own permitted and denied cases. An illustrative source example and an executed complete application are different forms of evidence.
