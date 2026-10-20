# CLI reference

Look up command families, inputs, outputs and failure behavior without confusing source analysis, artifact emission, assembly, preview and deployment.

## General conventions

Use `can --help`, `can help COMMAND` or `can COMMAND --help` to inspect the installed toolchain. `can --version` reports the selected tool version. Compiler diagnostics use exit `0` for success, `10` for reported source errors, and `2` for usage/tool failure; warnings alone do not block. Platform and dev commands have their own result envelopes and failure codes.

## Compiler commands

| Command | Inputs and effect |
| --- | --- |
| `can check [--generation-root=PATH] FILE.can...` | Analyze selected source files; no artifact emission. |
| `can compile [--format=json\|text] [--catalog=PATH] [--generation-root=PATH] [--native-scenario-receipts] FILE.can...` | Analyze and emit: text lists production/test module paths, JSON prints the artifact envelope to stdout. Neither writes the artifact file. |
| `can lint [--fix] FILE.can...` | Analyze, then report nonblocking recommendations. `--fix` reports proposed edits; it writes nothing. Analysis errors still exit `10`. |
| `can fmt FILE.can...` | Format source in place. |
| `can fmt --check FILE.can...` | Report formatting differences without writing. |
| `can policy FILE.can...` | Inspect declared roles, policies and operation gates. |
| `can explain CODE` | Explain a diagnostic code when an explanation is registered. |
| `can docs FILE.can... [--locale TAG] [--out PATH]` | Generate checked application reference Markdown; with no output path, write it to stdout. |
| `can completions SHELL` | Print a shell completion script to stdout. |
| `can lsp` | Serve the language protocol on stdin/stdout. |
| `can gen FILE.can [--dry-run] [--retry] [--settings PATH]` | Explicitly request saved-code generation. |
| `can validate FILE.can` | Compile source and run platform build, examples and Playwright checks against saved output without invoking AI. |

Compiler commands supporting structured results accept `--format=json` (also `--format json`). Use `--` before a filename that starts with `-`. `--generation-root=PATH` on `check` and `compile` selects the app output owner for saved generation locators when source files are nested. `--native-scenario-receipts` is a compile-only target option for the native State runtime, using its Cloudflare runtime stdlib facade. `completions` accepts `bash`, `zsh` or `fish`. `fmt` accepts `--check` to report differences without writing; with no file operand or with `-` it formats stdin to stdout. Formatting errors or check differences exit `10`; parse failures return JSON diagnostics without writing source. `fmt` rejects `--format` and `--catalog`; `lsp` rejects those flags and file operands. `docs --format` shapes diagnostics only; successful documentation output is Markdown. `docs --out` refuses `.can` paths and input files. Catalog selection uses `--catalog=PATH` where supported, then `CAN_CATALOG`, then workspace defaults. The installed launcher supplies its bundled catalog; application authors generally do not need to configure it.

`can gen FILE.can` prepares and accepts missing generation outputs. `--dry-run` reports planned work without generation or acceptance. `--retry` freshly regenerates every selected unit and keeps current saved code until acceptance. `--settings=PATH` selects an explicit configuration file; otherwise source mode uses the app root's `can.gen.toml`. The agent-facing dispatcher also accepts `can gen --request FILE` or one JSON request on stdin. `gen` outcomes use exit codes `0` success, `2` invalid request/configuration, `3` conflict or held lease, `4` validation failure, `5` runner failure and `6` unknown completion. See [generation controls](./03-generation-controls.md) and [generation configuration](./04-generation-configuration.md) for the versioned request and profiles.

## Platform commands

`can run`, `can test`, `can build`, `can deploy` and `can activate` delegate arguments to the platform tool. `can run` assembles modules and reports the local file entry. `can test` runs artifact examples. `can build` validates/prepares a build. `can deploy` requires an environment and can preview or apply. `can activate` evaluates activation readiness.

```sh
can run --artifact PATH
can test --artifact PATH
can build --artifact PATH
can deploy --artifact PATH --env NAME --preview
can deploy --artifact PATH --env NAME --yes
can activate --artifact PATH --env NAME
```

Without `--artifact`, discovery requires exactly one `./dist/*.artifact.json`; zero or multiple candidates refuse selection. Save an artifact with `can compile --format=json FILE.can > dist/NAME.artifact.json` after creating `dist`, and stop on compilation failure. Default text output is not the artifact JSON. Pass `--artifact` to select an existing artifact explicitly. `--preview` and `--yes` are deployment-only. A preview writes no deployment changes. `--yes` permits the apply route; inspect its actual result. Activation needs an environment. `build` and `deploy` also accept `--backend ts` or `--backend native` (`ts` is the default). Platform artifact/environment flags use separate values (`--artifact PATH`, `--env NAME`); do not assume every flag accepts `=`. All arguments after these subcommands pass through verbatim: `can run --help` asks the platform tool, whereas `can help run` asks the compiler dispatcher.

The platform reports JSON outcomes; nonzero status or `{ok:false}` is failure. Activation can return `{ok:true,active:false,reasons:[...]}` with exit `0`: this means the readiness check completed but the app is inactive. Require `active:true` before treating activation as successful. Deployment can likewise report `ok:true` for prepared output while `applied:false`; inspect `applied`, `applyStatus` and activation `verdict` before claiming a live release.

## Development controls

`can dev` passes control commands to the local development owner. `can dev ui` opens the human terminal/preview experience; it is the preview entry. `can dev help` returns the control command schemas, required flags and UI selection behavior. It is not a `can serve` command.

## Avoid stale commands

There are no public `can init`, `can serve`, `can migrate` or `can upgrade` commands. Migration and upgrade are app release workflows. The authoritative command list is the help output shipped with the installed version; this page summarizes stable user intents.
