# Deploying an app

Build and review a staging release, verify its provisioned environment, inspect apply and activation outcomes, and exercise the served application before promoting changes.

## Prepare the release

Check and validate the exact application sources and saved generated implementation, then build the artifact. Select the target environment explicitly and provision its bindings and secrets using [environments and secrets](01-environments-and-secrets.md). The build consumes a checked artifact; it does not migrate production records or activate a deployment.

## Review and apply

The platform command accepts `run`, `test`, `build`, `deploy`, `activate` and `docs` operations. A deployment requires an environment. Use preview to inspect the plan and its changes; apply only after reviewing the selected target, compatibility result, resource changes and data migration requirements.

```sh
can deploy --artifact path/to/Tasks.artifact.json --env staging --preview
can deploy --artifact path/to/Tasks.artifact.json --env staging --yes
```

`--yes` authorizes the apply path for that command; it does not make an incompatible app safe. The command reports whether the provider apply was attempted and whether it succeeded. Inspect `applied`, `applyStatus` and the activation verdict: `ok:true` can mean the command prepared its output even when provider apply failed or was not attempted. Preserve that result and investigate uncertain outcomes before retrying.

## Activate and verify

Activation evaluates the prepared environment's serve gate. It can refuse to activate and return reasons; an artifact existing on disk is not evidence that it is serving. Verify the active release, health and important user journeys in the target environment. For a schema change, follow the explicit predecessor and data checks in [schema migrations](03-schema-migrations.md), then use [upgrades and recovery](04-upgrades-and-recovery.md) for maintenance boundaries.

Do not describe a preview as a deployment, an apply attempt as successful activation, or a transport receipt as a business outcome. Keep the artifact identity, environment selection and operation result together for incident investigation.

## Walk through a staging release

This walkthrough deploys the complete [InterfaceTasks.can](../examples/interface-tasks/InterfaceTasks.can) application. It includes tasks, CSV intake, file evidence and read reports, so the environment must support its declared storage and file requirements. It needs no external AI, payment or mail provider.

Before starting, obtain a provisioned Cloudflare staging environment from the operator using the [environment handoff](01-environments-and-secrets.md#provision-an-environment-before-selecting-it). Confirm how to inspect the installed release, admission/maintenance state and recovery status in that target's operator surface. Provisioning and administrative access are prerequisites; `--env staging` does not create them.

### Build the selected application

Save the complete file in an application directory. Run the following with a compatible installed toolchain. The shell stops at the first failed command so diagnostics cannot be mistaken for a deployable artifact:

```bash
set -euo pipefail
can check InterfaceTasks.can
mkdir -p dist
can compile --format=json InterfaceTasks.can > dist/InterfaceTasks.artifact.json
can build --artifact dist/InterfaceTasks.artifact.json
can test --artifact dist/InterfaceTasks.artifact.json
```

Inspect the test result's actual case count: this interface demonstration contains no inline examples, so an empty example run is not behavioral coverage. Complete its [CSV](../07-Build-interfaces/07-csv-import.md), [export/print](../07-Build-interfaces/08-export-and-print.md) and [live-page](../07-Build-interfaces/09-live-pages-and-progress.md) journeys. For an app with generated implementation, complete its saved-output and browser acceptance before this release step.

### Review the environment-specific plan

```sh
can deploy --artifact dist/InterfaceTasks.artifact.json --env staging --preview > staging-preview.json
```

Read both the command status and JSON result. Verify the selected environment, resource identities, resource changes, compiler compatibility and activation verdict. Compare every resource with the operator's staging handoff. An environment named staging can still be incorrectly mapped to production resources.

A preview that reports an inactive verdict or unresolved compatibility reason is not ready to apply. Resolve the reason with the owning operator, then generate another preview from the exact current artifact/environment. Do not remove checks, invent missing snapshots or treat `ok:true` as approval to serve.

### Apply and inspect the outcome

After reviewing that plan and authorizing the target changes, run:

```sh
can deploy --artifact dist/InterfaceTasks.artifact.json --env staging --yes > staging-apply.json
can activate --artifact dist/InterfaceTasks.artifact.json --env staging > staging-activation.json
```

Inspect the apply result before running activation; the two lines are shown as separate steps, not an unconditional pipeline. Require a successful provider outcome (`applied`, `applyStatus`) and a positive activation verdict. `can activate` evaluates the serve gate; it is not a provider resource installer, a forced migration command or a general recovery/resume command. An `active:false` result can accompany a successfully completed control request.

If apply failed or its outcome is uncertain, inspect provider and release status before retrying. If activation refuses, leave affected access closed where required and follow [recovery](04-upgrades-and-recovery.md). Do not run the second command repeatedly hoping a missing gate will turn into a pass.

### Verify the served release and retained state

Use the target's actual application URL and authentication setup, not a guessed workers.dev hostname. Establish an authorized staging owner through the target's supported identity setup, invite a separate test member and select the staging team.

1. Confirm the target reports the intended artifact/release identity as active.
2. Create a synthetic task as the member, sign out, sign back in and verify the same task remains.
3. Complete the CSV review exercise, including its invalid and duplicate rows. Confirm the per-row outcomes against the stored tasks.
4. Attach a harmless text file through the generated upload flow, then download it through the authorized task field. Verify an unauthorized identity cannot read it.
5. Export the matching collection and print the open-task report. Confirm the result scope and field access.
6. Through the operator, perform a supported staging process restart; verify the task and attachment still resolve from retained storage.

These observations establish this release's staging behavior. A page returning HTTP 200 alone does not verify activation, persistence, membership or external dependencies.

### Rehearse a later schema change

Retain the staging owner snapshot identity and release before changing stored schema. Use that environment's actual predecessor in the [migration procedure](03-schema-migrations.md); the illustrative snapshot placeholder is never a valid value. A fresh installation and an upgrade exercise different paths. After conversion, verify old records, references, versions and pending work as well as newly created records before promoting the release to another environment.
