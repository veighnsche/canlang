# Deployment and maintenance

Prepare a selected application, inspect the deployment plan, and preserve data, authority and outstanding work when changing an installed version.

## Understand the deployment unit

One deployment selects one app and its included source owners. Source describes business identity and composition; the platform prepares runtime modules, schemas, bindings and compatibility information. The target architecture uses workerd and Cloudflare D1, with Durable Objects and R2 where the application requires them.

Keep compiler, language schema and runtime package versions compatible. A local preview uses local resources and session ownership; it is not proof of a remote deployment or configured provider account.

## Prepare and validate an application

Check the selected source, compile it and execute its examples and browser journeys. Retain the actual artifact produced by the compiler/platform preparation flow, alongside its required sidecars. A compiler JSON error envelope is not a deployment artifact.

The platform commands accept `--artifact PATH` and `--env NAME`. Without an artifact argument they discover exactly one `./dist/*.artifact.json`, refusing missing or ambiguous choices. Use explicit paths when preparing several apps.

Preparation needs a compatibility descriptor, an environment selection for the named environment, and an installed-runtime declaration. For an artifact named `app.artifact.json`, their filenames are:

```text
app.descriptor.json
app.production.environment.json
app.target.json
```

These contain typed platform state, not arbitrary app settings. They must come from the matching preparation/runtime contract; creating empty JSON files will not satisfy the checks. An installed activation snapshot and outstanding work also matter for activation. A missing-producer or compatibility error names the prerequisite to resolve.

## Review before applying

Given a prepared artifact and its matching sidecars, run:

```sh
can build --artifact dist/app.artifact.json --env production
can deploy --artifact dist/app.artifact.json --env production --preview
```

The preview checks compatibility and renders the proposed deployment without writing deployment outputs or invoking Wrangler. Inspect the selected environment, resources and application identity before applying:

```sh
can deploy --artifact dist/app.artifact.json --env production --yes
```

Confirmed deployment writes the portable bundle, plan and Wrangler configuration, then attempts the remote apply. It requires the configured Cloudflare account/resources, Wrangler and deployment credentials such as `CLOUDFLARE_API_TOKEN`. Keep secrets out of application source and version control. A bare deploy without preview or confirmation refuses.

Read the returned outcome. Prepared files do not prove remote apply, and a cancelled or interrupted apply can have an uncertain remote outcome. Inspect the actual environment before manually retrying; automatic rollback is not implied.

## Manage installed identity and schema

Moving source files preserves declaration identity; renaming an app, package, model or interface can change stored and public identities. Compare the old installed schema and interfaces with the new selected app before activation.

A migration identifies its pinned predecessor with `from`. Maintenance declarations describe supported renames and bounded initialization under the migration contract. A source rename alone does not move data. Backfills must preserve ownership, references, locks and complete final invariants; do not run them as ordinary user CRUD loops.

Existing scheduled or provider work retains its original identity and contract. Drain, reconcile or retain a compatible path for outstanding work before activating an incompatible release. An uncertain external delivery cannot be treated as cancelled merely because code changed.

## Check activation and links

`can activate --artifact PATH --env NAME` evaluates the activation bundle and reports its verdict. Read whether it is active and the stated reasons; a checked bundle is not permission to bypass missing runtime inventory.

For outbound application links, configure the trusted deployment base with `CAN_DEPLOYMENT_BASE`, for example `https://app.example/`. The `app_url` builtin uses that trusted context and does not infer it from request headers. Root mounts are the supported configuration for the current link assembly path. A generated URL never grants its recipient record access.

After apply and activation, verify real sign-in, team selection, allowed and denied operations, persistence, integrations and the application's public origin. Keep release and recovery records with the installed environment.
