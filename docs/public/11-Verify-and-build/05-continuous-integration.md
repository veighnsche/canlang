# Continuous integration

Configure an application CI runner, run source and behavioral checks with fail-fast scripts, and require real browser acceptance before handing the checked build to deployment.

## A practical pipeline

The application pipeline should select the app's entry source, run `can check`, run `can validate` when saved generated implementation is present, emit/build the selected artifact, and execute the app's declared examples and required acceptance journey. A deployment stage should consume that exact checked build and a separately configured environment.

```sh
can check Tasks.can
can validate Tasks.can
mkdir -p dist
can compile --format=json Tasks.can > dist/Tasks.artifact.json
can build --artifact dist/Tasks.artifact.json
can test --artifact dist/Tasks.artifact.json
```

Configure the pipeline to stop on any failed command. Redirection captures the JSON artifact; default text compilation would capture only module paths. The `validate` step requires the app's saved implementation and Playwright setup; omit it for an app without saved generated code. Confirm the artifact and source revision match before testing or deployment.

## Generation is explicit

Ordinary CI does not call a model or coding CLI. It consumes checked, saved implementation and fails with a useful missing/incompatible output result. If a team deliberately adds generation preparation, make it a separate reviewed job with its runner configuration and candidate acceptance policy; a successful generation response is not acceptance.

## Keep app and repository checks distinct

Application CI verifies that app source, examples and user workflows satisfy the app contract. CanLang repository contributors separately run compiler, package and runtime checks on CanLang itself. An app author should not need a compiler checkout or contributor-only catalog-generation step for the normal installed toolchain.

Retain actionable diagnostics, the selected source revision, and the result of each user-facing journey. Avoid publishing secrets, private fixture values or unredacted provider responses in CI logs. A passing app pipeline does not by itself qualify every production environment or external provider account.

## Prepare the runner and app checkout

Install the selected standalone Can release on a supported runner using the [installation instructions](../01-Get-started/03-installation.md). Make its executable available in the CI job's PATH and verify `can --version`. For a browser-acceptance job, install the matching [browser-tools sidecar](04-workflow-and-interface-testing.md#install-browser-tools-for-acceptance) and required OS libraries before running the app checks.

The checkout must include the complete `.can` composition, accepted saved implementation where used, exactly one app-local Playwright configuration and its real browser journey/harness. Supply only the test environment's required bindings and credentials through the CI secret store. Do not run production providers just because a fixture names their capability.

## Use a fail-fast application script

Save this as `ci/check-app.sh` in the example application's repository and run it with `bash ci/check-app.sh` from that repository's root. It assumes the downloaded `VerifiedTasks.can` is there. The script performs source, build and example verification; it does not claim browser acceptance:

```bash
#!/usr/bin/env bash
set -euo pipefail

can --version
can check VerifiedTasks.can
mkdir -p dist
can compile --format=json VerifiedTasks.can > dist/VerifiedTasks.artifact.json
can build --artifact dist/VerifiedTasks.artifact.json
can test --artifact dist/VerifiedTasks.artifact.json
```

For a generated app requiring saved-output acceptance, add its explicit validation command after source checking, using its actual entry filename:

```sh
can validate PromptStudio.can
```

That command requires PromptStudio's accepted implementation and its app-local acceptance setup; it is not a substitute filename for the independent VerifiedTasks example. A generation candidate acceptance run uses the supplied candidate environment described in the browser-testing lesson. Do not point its tests at a shared already-running preview.

## Integrate the script with CI

Use a job with these ordered steps: check out the app, install/restore the compatible Can toolchain, install browser tools when required, run the app script, run the required browser acceptance, and retain actionable failure output. For example, the check step in a GitHub Actions job whose earlier steps provisioned Can is:

```yaml
- name: Check app source, build and examples
  shell: bash
  run: bash ci/check-app.sh
```

This is a workflow step fragment, not an entire workflow or an installer. Do not put `continue-on-error` on required checks. Cache ordinary tool/dependency downloads if useful, but never reuse another job's preview session, actor credentials or mutable business state. Upload diagnostic and test reports only after checking their privacy; avoid protected preview URLs and raw login responses.

A deployment job consumes the successful job's exact artifact/build under separately authorized environment settings. A failed command must not leave a redirected diagnostics file eligible for deployment merely because its filename ends in `.artifact.json`.
