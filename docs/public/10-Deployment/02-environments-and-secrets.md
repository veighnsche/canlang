# Environments and secrets

Bind each application release to resources and credentials provisioned for its intended environment.

An environment supplies concrete bindings for the app's declared capabilities. The source declaration owns which capability is required; environment configuration supplies the resource identity and secret values. Keep development, staging and production resources distinct so a local preview cannot accidentally write production data.

Before build or deployment, verify that every required binding is present, compatible with the artifact contract and associated with the intended account. Provider credentials must be available to the deployment operator or protected deployment environment, not copied into `.can` source, generated browser assets, fixtures or committed configuration.

Rotate credentials through the provider's supported process and verify the newly bound secret without printing its value. A missing or rejected credential is an environment failure, not a reason to grant the app broader source authority. Resource provisioning and secret setup happen before deployment; deployment consumes the selected environment and reports compatibility or apply failures.

If an environment changes resource identity or schema, check the installed application's compatibility and pending work before activation. A source-level binding declaration does not itself create provider resources or prove they are healthy. See [deploying an app](./01-deploying-an-app.md) and [operating an app](./05-operating-an-app.md).
