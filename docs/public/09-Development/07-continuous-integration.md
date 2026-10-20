# Continuous integration

Run application-owned checks and examples on each proposed app change using the same selected sources and saved implementation as the build.

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
