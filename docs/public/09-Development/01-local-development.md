# Local development

Use the local toolchain to check a selected application, preview it safely, and keep the running session aligned with source changes.

## Select and check an application

Work from the application root and select its `.can` entry source explicitly when the repository contains multiple applications:

```sh
can check Tasks.can
can compile Tasks.can
```

`check` analyzes source and reports diagnostics. `compile` performs that analysis: its default text output lists emitted module paths, while `--format=json` emits the artifact envelope to stdout. Neither writes the artifact to a named file. Use the build workflow when a platform artifact is required. A source fragment can be checked only when its dependencies and owning application context are supplied.

## Preview the app

Start the human preview using `can dev ui --source Tasks.can`. Add `--check-mode automatic` to check saved changes automatically; manual checking is the default. Use the selection flags shown by `can dev help`. The terminal reports the selected source, session status, preview address, diagnostics and available controls. `can dev ui` with no source attaches to the verified selected owner; it does not guess which app to launch. Keep the process available while using the preview.

Preview requests run with the selected local app identity and its declared access rules. A hidden or disabled control is not an authorization rule: exercise the operation as both an allowed and a denied actor. Local preview state is isolated from production, but external services still require appropriate local bindings and credentials.

## Source changes and refresh

The development owner tracks source revisions and the serving build. Accepted automatic refresh captures a coherent source revision, checks and assembles it, then advances the preview only when the new build is valid. If compilation fails, the diagnostic belongs to that revision and the last valid preview remains identifiable; do not assume a failed change became live. Recheck after saving the correction and confirm the preview reports the new source revision.

Local business state is retained according to the selected profile and app storage contract. A source refresh is not a schema migration and does not erase application data to make a new model fit. Schema changes that need data conversion follow [schema migrations](../10-Deployment/03-schema-migrations.md).

## Inspect and stop a session

Use `can dev help` for the control names and required session/revision values. Status, diagnostics, example runs and failures are tied to the selected session and source revision. A stale revision refusal means the source advanced; inspect fresh status and rerun the action against the current revision. Stop only the session you own. See [development controls](../12-Reference/02-development-controls.md) for the machine protocol.

## When preview fails

First distinguish source diagnostics from tool or owner failures. A source diagnostic names the revision and location to repair. A missing or mismatched owner means selection must be resolved, not that the app source is invalid. A preview build can succeed while a particular external service is unavailable; verify that service independently and never interpret a transport receipt as a completed business action.
