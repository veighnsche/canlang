# Environments and secrets

Prepare environment-specific resources, bindings and secrets, distinguish local preview from retained staging state, and give the deployment operator an explicit provisioning handoff.

An environment supplies concrete bindings for the app's declared capabilities. The source declaration owns which capability is required; environment configuration supplies the resource identity and secret values. Keep development, staging and production resources distinct so a local preview cannot accidentally write production data.

Before build or deployment, verify that every required binding is present, compatible with the artifact contract and associated with the intended account. Provider credentials must be available to the deployment operator or protected deployment environment, not copied into `.can` source, generated browser assets, fixtures or committed configuration.

Rotate credentials through the provider's supported process and verify the newly bound secret without printing its value. A missing or rejected credential is an environment failure, not a reason to grant the app broader source authority. Resource provisioning and secret setup happen before deployment; deployment consumes the selected environment and reports compatibility or apply failures.

If an environment changes resource identity or schema, check the installed application's compatibility and pending work before activation. A source-level binding declaration does not itself create provider resources or prove they are healthy. See [deploying an app](02-deploying-an-app.md) and [operating an app](05-operating-an-app.md).

## Provision an environment before selecting it

An environment name such as `staging` selects an existing deployment target. It is not a command to create an account, database, secret store or domain. The environment operator provisions those resources through the target provider's supported administration surface, then makes their resolved identities available to Can's deployment integration.

For the Cloudflare target, prepare this handoff:

| Environment input | Required evidence |
| --- | --- |
| Account and application target | The selected provider account and worker/service identity belong to staging. |
| Resource bindings | Every artifact requirement resolves to a compatible resource of the declared kind and logical name. |
| Secrets | Required secret names exist in the target secret store; values are never embedded in an artifact or public config. |
| Non-secret configuration | Origins, provider profiles and other declared values refer to staging endpoints. |
| Installed runtime | Language/contracts/runtime compatibility and required capabilities are available. |
| Installed owner state | Fresh-install status or the exact installed owner snapshots and retained work contracts are known. |
| Operator access | The operator may prepare/apply this environment and inspect activation/recovery status. |

Use the artifact's requirements rather than copying another app's resource list. Identity storage and business state have distinct responsibilities; do not substitute a database merely because its binding name looks similar. File use, authored queues, services and other infrastructure add their own requirements. A missing target capability is a deployment refusal, not permission to remove the app's requirement.

Provider resource creation and Can release activation are separate steps. Provider credentials authorize infrastructure changes; they do not grant application users access to business records. An operator must retain resource IDs and secret-name mappings in protected environment configuration without asking app authors to fabricate compatibility evidence or hand-author internal activation files.

## Keep preview and staging persistence distinct

Three different previews appear in this handbook:

| Surface | Persistence contract |
| --- | --- |
| `can dev ui` local application preview | Uses its selected local profile's state. It is isolated from the remote staging environment. A successful compatible source refresh must not silently reset user data to make a new schema fit. |
| `can deploy --preview` | Inspects and reports a release plan. It performs no remote provisioning, deployment or migration, and writes no deployment output files. Capturing stdout yourself writes only your local report. |
| A deployed staging app | Uses the staging environment's retained resources. Page reloads and new code releases do not imply a data reset. |

Local preview storage lifetime must be identified by its profile/operator. Do not use a local session as a backup, infer persistence across deleted profiles or owner cleanup, or promise restart durability without that profile's explicit guarantee. For a staging persistence check, create a synthetic record, restart the serving process through the target's supported lifecycle control, then verify the same record and identity remain. Stop immediately if the target would substitute temporary storage for a required retained store.

A native/Soda target has its own provider inventory and storage lifecycle. A Cloudflare environment selection is not automatically a portable Soda environment. Verify that target's contract before selecting it; do not apply Cloudflare provisioning commands to a native host.
