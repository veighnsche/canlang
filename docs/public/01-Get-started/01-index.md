# Build company apps with CanLang

Build business applications with typed records, explicit permissions and guarded workflows. Choose a task, follow a complete example, and learn how to verify its behavior before deployment.

## Build your first application

[Install Can](03-installation.md), build the complete [Tasks app](05-first-app.md), then add a [guarded workflow](07-first-workflow.md). These tutorials cover source, checking, preview, sign-in, team selection, record changes and behavioral examples.

Use the [example index](02-example-progression.md) to download a complete project or choose the next teaching stage. It distinguishes full applications, replacement tutorial versions and contextual fragments.

## Choose a path

| What you want to do | Start here | Continue with |
| --- | --- | --- |
| Understand `.can` and `$` syntax | [Source syntax](../02-Language-foundations/01-source-syntax.md) | [Generation tutorial](../03-Generate-implementation/01-generation-lifecycle.md) |
| Model records and relationships | [Models and relationships](../04-Model-and-query-data/01-models-and-relationships.md) | [Defaults and validation](../04-Model-and-query-data/02-defaults-and-validation.md) |
| Filter data and calculate reports | [Queries and aggregates](../04-Model-and-query-data/03-queries-and-aggregates.md) | [Money](../04-Model-and-query-data/04-money-and-currency.md), [dates](../04-Model-and-query-data/05-dates-and-timezones.md) |
| Control who can read and act | [Authentication and teams](../05-Permissions-and-policy/01-authentication-and-teams.md) | [Approval recipe](../10-Recipes/01-approval-workflow.md) |
| Add a guarded business operation | [Scenarios and effects](../06-Business-workflows/02-scenarios-and-effects.md) | [Transactions and concurrency](../06-Business-workflows/03-transactions-and-concurrency.md) |
| Schedule reminders or reserve resources | [Reminder recipe](../10-Recipes/03-reminders-and-escalation.md) | [Booking recipe](../10-Recipes/02-resource-booking.md) |
| Build pages, lists and forms | [Pages and navigation](../07-Build-interfaces/01-pages-and-navigation.md) | [Forms](../07-Build-interfaces/04-forms-and-inputs.md), [components](../07-Build-interfaces/02-components-and-layout.md) |
| Import, export or print records | [CSV import](../07-Build-interfaces/07-csv-import.md) | [Export and print](../07-Build-interfaces/08-export-and-print.md) |
| Connect an external service | [Contracts and bindings](../08-Connect-services/01-contracts-and-service-bindings.md) | [External sync recipe](../10-Recipes/04-external-sync.md) |
| Handle files, mail or payments | [Files and attachments](../08-Connect-services/03-files-and-attachments.md) | [Mail](../08-Connect-services/04-email-and-mailboxes.md), [payments](../08-Connect-services/05-payments.md) |
| Call AI at runtime | [Text and image generation](../09-Runtime-AI/01-text-and-image-generation.md) | [Judgments](../09-Runtime-AI/02-judgments.md), [private knowledge](../10-Recipes/06-private-knowledge-assistant.md) |
| Expose an app to an MCP host | [MCP discovery and calls](../08-Connect-services/07-mcp.md) | [Typed actions](../06-Business-workflows/05-actions-and-invocations.md) |
| Compose multiple packages | [Composed-app recipe](../10-Recipes/07-composed-business-app.md) | [Apps and packages](../02-Language-foundations/04-apps-and-packages.md) |
| Set up development and verification | [Editor installation](04-editor-support.md) | [Local controls](06-local-development.md), [CI](../11-Verify-and-build/05-continuous-integration.md) |
| Deploy or recover an application | [Staging walkthrough](../12-Deploy-and-operate/02-deploying-an-app.md) | [Migrations](../12-Deploy-and-operate/03-schema-migrations.md), [recovery](../12-Deploy-and-operate/04-upgrades-and-recovery.md) |

## Choose build-time generation or runtime AI

`$"..."` prompts and named `$Name` styles help create saved application implementation before ordinary builds. Follow [PromptStudio](02-example-progression.md#extend-an-app-with-dollar-prompts) for generation, acceptance and refinement.

Runtime AI sends typed requests while the application is running. It needs provider bindings, bounded inputs, progress and explicit review. Follow the [reviewed AI recipe](../10-Recipes/05-reviewed-ai-actions.md). Neither use grants permission to bypass source-owned policies or business rules.

## Find a topic

For an exact form, use the [syntax reference](../13-Language-reference/01-syntax-reference.md), [context variables](../02-Language-foundations/05-context-and-defaults.md) or [types and builtins](../13-Language-reference/02-types-and-builtins.md). For commands, use the [CLI reference](../15-Tooling-reference/01-cli.md). For usable component combinations, start with the [component lesson](../07-Build-interfaces/02-components-and-layout.md), then follow its reference links.

If a check fails, use [diagnostics and help](../11-Verify-and-build/01-diagnostics-and-help.md). If a running operation is uncertain, use [delivery recovery](../08-Connect-services/02-deliveries-and-recovery.md). These are different problems: a successful compilation is not evidence of a completed external action.
