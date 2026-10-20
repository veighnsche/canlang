# Builds and validation

Check source, emit and build an artifact, run behavioral examples, and validate saved implementation with browser acceptance while keeping each result and its limits clear.

## Check and emit

```sh
can check Tasks.can
can compile --format=json Tasks.can > Tasks.artifact.json
```

`check` resolves and analyzes the selected source inputs. `compile --format=json` additionally emits the artifact envelope to stdout; the shell redirection above saves it. Default text output lists module paths and is not a saved artifact. Continue only if compilation exits successfully: an error result is diagnostics, not an artifact. These commands do not install runtime resources or deploy the app.

## Validate and build

If the app uses saved generated implementation, validate it explicitly:

```sh
can validate Tasks.can
```

Validation compiles the source and runs platform build, declared examples and Playwright checks against saved output without AI generation. The app must supply the required saved implementation and browser-check setup. Missing or incompatible output is a corrective result, not permission for an ordinary build to regenerate code. Use explicit generation when you intend to request new candidates, then review/accept through the generation lifecycle.

The platform build selects an artifact, validates compatibility and prepares a build:

```sh
can build --artifact Tasks.artifact.json
```

`can compile` and `can build` have different inputs and outputs. A successful build is not a deployment, and a deployment preview is not an applied release. Platform outputs and environment setup are described in [deploying an app](../12-Deploy-and-operate/02-deploying-an-app.md).

## Run assembles modules

`can run --artifact PATH` assembles the app's modules and reports the local file entry. It does not mean that the deployment is live or that remote services are healthy. Use `can dev ui` as the human preview entry; see [local development](../01-Get-started/06-local-development.md).

## Preserve the validated scope

Run checks against the complete selected app and its composition inputs. A source fragment can pass only when its required declarations are available. Keep diagnostics and artifact identity together when handing a result to CI or a deployment command; do not apply a stale artifact after its source or generated implementation has changed.

## Distinguish the results before moving on

| Command or observation | What it verifies | What it does not verify |
| --- | --- | --- |
| `can check` succeeds | Selected source resolves and satisfies static checks. | Behavioral examples, browser rendering or provider execution. |
| `can compile --format=json` succeeds | An artifact was emitted for that selected source. | Installed resources or a running preview. |
| `can build --artifact ...` succeeds | Platform assembly accepts that artifact and saved implementation. | Business examples or production deployment. |
| `can test --artifact ...` succeeds | Declared examples passed through their operation boundaries. | Real provider calls or a browser journey. |
| `can validate` succeeds | The required saved-output acceptance workflow passed, including build, examples and browser checks. | Every production binding or account. |

For acceptance setup, use the [browser installation and app-local configuration](04-workflow-and-interface-testing.md#configure-app-local-browser-acceptance). Keep exactly one configuration beside the source. Missing browser tools, an empty test suite, a skipped test or a preview of the wrong source are corrective failures. Do not replace them with a source-only “validation” success.

If saved generated implementation is missing or incompatible, prepare it through the explicit [generation lifecycle](../03-Generate-implementation/01-generation-lifecycle.md). Ordinary validation must not call a model to fill the gap. After correcting source or saved code, rerun the affected checks against the new revision rather than deploying the old artifact.
