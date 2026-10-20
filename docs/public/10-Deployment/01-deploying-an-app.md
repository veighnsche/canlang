# Deploying an app

Prepare a release for one selected app and environment, review the plan, apply it deliberately, then verify the actual activation outcome.

## Prepare the release

Check and validate the exact application sources and saved generated implementation, then build the artifact. Select the target environment explicitly and provision its bindings and secrets using [environments and secrets](./02-environments-and-secrets.md). The build consumes a checked artifact; it does not migrate production records or activate a deployment.

## Review and apply

The platform command accepts `run`, `test`, `build`, `deploy`, `activate` and `docs` operations. A deployment requires an environment. Use preview to inspect the plan and its changes; apply only after reviewing the selected target, compatibility result, resource changes and data migration requirements.

```sh
can deploy --artifact path/to/Tasks.artifact.json --env staging --preview
can deploy --artifact path/to/Tasks.artifact.json --env staging --yes
```

`--yes` authorizes the apply path for that command; it does not make an incompatible app safe. The command reports whether the provider apply was attempted and whether it succeeded. Inspect `applied`, `applyStatus` and the activation verdict: `ok:true` can mean the command prepared its output even when provider apply failed or was not attempted. Preserve that result and investigate uncertain outcomes before retrying.

## Activate and verify

Activation evaluates the prepared environment's serve gate. It can refuse to activate and return reasons; an artifact existing on disk is not evidence that it is serving. Verify the active release, health and important user journeys in the target environment. For a schema change, follow the explicit predecessor and data checks in [schema migrations](./03-schema-migrations.md), then use [upgrades and recovery](./04-upgrades-and-recovery.md) for maintenance boundaries.

Do not describe a preview as a deployment, an apply attempt as successful activation, or a transport receipt as a business outcome. Keep the artifact identity, environment selection and operation result together for incident investigation.
