# Public handbook filetree

The handbook contains **87 public pages in 15 sections**. Its order follows setup, language foundations, saved-code generation, application features, complete recipes, verification, deployment and focused reference.

## Reading order

Setup and the first task journey come first. Saved-code generation has an early, distinct home; runtime AI follows service delivery contracts. Recipes combine those features before verification and deployment. Language, component and tooling references remain separate lookup sections.

Filenames and folders determine handbook order. Existing page slugs and headings are preserved, so this reorganization does not change the flat website routes or require new route redirects. `README.md`, `FILETREE.md`, examples and assets are not articles.

## Complete handbook tree

```text
docs/public/
  README.md
  FILETREE.md
  01-Get-started/
    01-index.md  # Build company apps with CanLang
    02-example-progression.md  # Find a complete CanLang example
    03-installation.md  # Install the CanLang toolchain
    04-editor-support.md  # Editor support
    05-first-app.md  # Build your first Tasks app
    06-local-development.md  # Local development
    07-first-workflow.md  # Add a guarded completion workflow to Tasks
    08-ai-authoring.md  # Author CanLang with an AI assistant
  02-Language-foundations/
    01-source-syntax.md  # Source layout and syntax
    02-types-and-values.md  # Types, schemas and values
    03-expressions-and-derives.md  # Expressions, scopes, and derives
    04-apps-and-packages.md  # Compose a multi-file task and note application
    05-context-and-defaults.md  # Context and default declarations
    06-descriptions-and-app-reference.md  # Descriptions and generated app reference
  03-Generate-implementation/
    01-generation-lifecycle.md  # Generate and refine a complete application
    02-traits-and-custom-keywords.md  # Traits and custom keywords
    03-styles-and-custom-views.md  # Styles and custom views
    04-editing-and-refinement.md  # Editing and refinement
  04-Model-and-query-data/
    01-models-and-relationships.md  # Model expenses, references and contained records
    02-defaults-and-validation.md  # Default, validate and uniquely identify expense data
    03-queries-and-aggregates.md  # Query and summarize expense records
    04-money-and-currency.md  # Calculate money and choose rounding boundaries
    05-dates-and-timezones.md  # Calculate dates, timezones and calendar recurrence
    06-history-and-retention.md  # History and retention
  05-Permissions-and-policy/
    01-authentication-and-teams.md  # Understand sign-in, teams and expense-review access
    02-read-policies-and-field-access.md  # Grant expense rows, fields and report results
    03-roles-and-operation-permissions.md  # Declare roles and authorize expense operations
    04-invariants-and-locks.md  # Preserve expense rules with invariants and locks
    05-reviewing-business-policy.md  # Walk through the expense permission rules
  06-Business-workflows/
    01-crud-and-record-lifecycle.md  # Restrict CRUD and control record lifecycle
    02-scenarios-and-effects.md  # Write expense operations with explicit effects
    03-transactions-and-concurrency.md  # Understand commits, rollback, conflicts and replay
    04-state-machines.md  # Protect the expense lifecycle with a state machine
    05-actions-and-invocations.md  # Actions and invocations
    06-events-and-hooks.md  # Handle expense events, hooks and durable fanout
    07-scheduling-and-recurring-work.md  # Schedule, cancel and recover expense reminders
    08-fanout-and-batch-work.md  # Fanout and batch work
  07-Build-interfaces/
    01-pages-and-navigation.md  # Build typed pages and discoverable navigation
    02-components-and-layout.md  # Components and layout
    03-collections-and-views.md  # Browse task collections and reuse ordinary views
    04-forms-and-inputs.md  # Build task forms and canonical actions
    05-settings-and-preferences.md  # Save personal task views and presentation preferences
    06-localization.md  # Translate task interfaces and outbound messages
    07-csv-import.md  # CSV import
    08-export-and-print.md  # Export and print
    09-live-pages-and-progress.md  # Live pages and progress
  08-Connect-services/
    01-contracts-and-service-bindings.md  # Connect an account lookup service from request to recovery
    02-deliveries-and-recovery.md  # Deliveries and recovery
    03-files-and-attachments.md  # Files and attachments
    04-email-and-mailboxes.md  # Email and mailboxes
    05-payments.md  # Payments
    06-external-data-and-app-connections.md  # External data and app connections
    07-mcp.md  # MCP
  09-Runtime-AI/
    01-text-and-image-generation.md  # Generate and review text and images
    02-judgments.md  # Judgments
    03-knowledge-corpora.md  # Knowledge corpora
  10-Recipes/
    01-approval-workflow.md  # Approve expenses with separate requester and reviewer authority
    02-resource-booking.md  # Reserve a resource without overlapping bookings
    03-reminders-and-escalation.md  # Schedule a reminder and reject stale escalation
    04-external-sync.md  # Review external account changes before applying them
    05-reviewed-ai-actions.md  # Review an AI draft before accepting it
    06-private-knowledge-assistant.md  # Ask a private handbook and verify its evidence
    07-composed-business-app.md  # Compose a task board and linked notes
  11-Verify-and-build/
    01-diagnostics-and-help.md  # Diagnostics and help
    02-fixtures-and-examples.md  # Fixtures and examples
    03-builds-and-validation.md  # Builds and validation
    04-workflow-and-interface-testing.md  # Workflow and interface testing
    05-continuous-integration.md  # Continuous integration
  12-Deploy-and-operate/
    01-environments-and-secrets.md  # Environments and secrets
    02-deploying-an-app.md  # Deploying an app
    03-schema-migrations.md  # Schema migrations
    04-upgrades-and-recovery.md  # Upgrades and recovery
    05-operating-an-app.md  # Operating an app
    06-instrumentation.md  # Instrumentation
  13-Language-reference/
    01-syntax-reference.md  # Syntax reference
    02-types-and-builtins.md  # Types and builtin values
    03-errors-and-wire-values.md  # Errors and wire values
    04-service-contracts.md  # Service contracts
  14-Component-reference/
    01-components-layout-and-navigation.md  # Layout and navigation
    02-components-content-and-feedback.md  # Content and feedback
    03-components-inputs.md  # Inputs
    04-components-disclosure-and-actions.md  # Disclosure and actions
    05-components-collections-and-media.md  # Collections and media
  15-Tooling-reference/
    01-cli.md  # CLI reference
    02-development-controls.md  # Development controls
    03-generation-configuration.md  # Generation configuration
    04-generation-controls.md  # Generation controls
  examples/  # Complete source projects and sample data.
  assets/    # Public visual assets.
```

## Ownership and publication

Each concept has one explanatory owner. Recipes link complete source and setup; references supply exact forms. The handbook describes the accepted intended product, while implementation and qualification gaps stay in engineering records.

Source changes must update affected local links. Publishing regenerates the website snapshot from an authorized committed revision; moving a Markdown page does not itself publish anything.
## Source investigation behind the tree

The structure follows accepted requirements and observable application responsibilities, checked against actual source owners. These are the most consequential sources inspected; this is not a claim that every source file or runtime branch was audited.

| Public subject | Contract and source basis | Consequence for the tree |
| --- | --- | --- |
| Product scope and final outcomes | [Requirements](../specification/REQUIREMENTS.md), [design](../specification/DESIGN.md), [grammar](../specification/GRAMMAR.md), [finished-product workflows](../ideal-filetree-plan/finished-product/workflows.md), [application workflows](../ideal-filetree-plan/finished-product/apps.md) | Company SaaS capabilities define coverage. Missing current implementation does not remove a required topic. |
| Source and composition | [Parser](../../compiler/src/syntax/parser.rs), [resolution](../../compiler/src/analysis/resolve.rs), [type analysis](../../compiler/src/analysis/types.rs), [TeamTasks](../../examples/TeamTasks.can) | Separate stable owning identities, selected composition, imports, authority and public exposure. |
| Values and data | [Values catalog](../../packages/values/src/catalog.ts), [money](../../packages/values/src/money.ts), [timezones](../../packages/values/src/timezone.ts), [query engine](../../packages/state/src/query/engine.ts) | Exact money, calendar time, input meaning and authorized reporting deserve first-class explanations. Internal exports do not automatically become source features. |
| Identity and policy | [Authentication context](../../packages/identity/src/authentication/context.ts), [membership](../../packages/identity/src/teams/membership.ts), [roles](../../packages/identity/src/teams/roles.ts), [query policy](../../packages/state/src/query/source-policy.ts), [grants](../../packages/state/src/policy/grants.ts) | Identity lifecycle, operation permission, readable fields and business invariants are distinct reader questions. |
| Canonical workflows | [Effect analysis](../../compiler/src/analysis/effects.rs), [scenario emission](../../compiler/src/codegen/scenario_calls.rs), [transitions](../../packages/state/src/effects/transition.ts), [scheduling](../../packages/work/src/schedule/every.ts), [durable dispatch](../../packages/work/src/dispatch/durable.ts) | Teach ordered operations, atomic owner commits, lifecycle machines, trusted handlers, scheduling and complete fanout. |
| UI and localization | [Approved UI vocabulary](../design/UI-COMPONENTS.md), [UI catalog](../../packages/ui/src/catalog.ts), [forms](../../packages/ui/src/forms.ts), [settings](../../packages/ui/src/settings.ts), [navigation](../../packages/ui/src/navigation.ts), [messages](../../packages/ui/src/messages.ts), [polling](../../packages/ui/src/browser/polling.ts) | Cover all components, shared shell/preferences, typed forms, localization and live behavior; avoid an examples-only subset. |
| Generated interfaces | [MCP server](../../packages/interfaces/src/mcp/server.ts), [tool schemas](../../packages/interfaces/src/mcp/schemas.ts), [discovery](../../packages/interfaces/src/mcp/discovery.ts), [CSV](../../packages/interfaces/src/http/csv.ts), [export](../../packages/interfaces/src/http/export.ts), [print](../../packages/interfaces/src/http/print.ts) | Give MCP, import and export/print explicit homes, with a shared canonical permission/schema story. |
| Services and external work | [Service contracts](../../packages/contracts/src/services.ts), [work contracts](../../packages/contracts/src/work.ts), [service catalog](../../packages/services/src/catalog.ts), [mail](../../packages/services/src/mail/adapter.ts), [judgments](../../packages/services/src/judgments/specification.ts), [media mappings](../../packages/services/src/media/mapping.ts) | Separate transport recovery from business outcomes; document accepted capabilities and source-owned judgments/corpora rather than incidental provider wrappers. |
| Files | [Upload](../../packages/files/src/upload/index.ts), [finalization](../../packages/files/src/finalize/index.ts), [provenance](../../packages/files/src/provenance/index.ts), [retention](../../packages/files/src/retention/index.ts), [host custody](../../packages/files/src/host/sqlite-core.ts) | Cover the complete real-byte lifecycle, immutable versions, current read permission and disposal. |
| Saved-code generation | [Accepted generation requirements](../specification/BUILD_GENERATION_REQUIREMENTS.md), [generation analysis](../../compiler/src/analysis/generation.rs), [configuration](../../compiler/src/analysis/generation_config.rs), [intake](../../compiler/src/analysis/generation_intake.rs), [acceptance](../../packages/cloudflare/src/generation/acceptance.ts) | A distinct generation chapter covers Given extensions and Then rendering/styles, reuse, direct editing and recovery. Ordinary When code stays authored. |
| Development and reference | [CLI](../../compiler/src/cli.rs), [application docs](../../compiler/src/docs.rs), [native dev CLI](../../dev-server/src/cli.rs), [dev lifecycle](../../dev-server/src/app.rs), [foreground terminal](../../dev-server/src/foreground.rs), [editor](../../editors/vscode/README.md), [LSP workspace integration](../../compiler/tests/lsp_workspace.rs) | Human terminal/editor workflows and agent controls both need documentation. Emission, assembly and browser preview are different operations. |
| Examples and testing | [Example analysis](../../compiler/src/analysis/examples.rs), [BDD emission](../../compiler/src/codegen/bdd.rs), [Testkit](../../packages/testkit/README.md), [fixture seeds](../../packages/testkit/src/fixtures/seeds.ts), [ExpenseFlow](../../examples/ExpenseFlow.can) | Teach isolated examples and shared-state journeys with real authority, files and independently authored expectations. |
| Deployment and change | [Installation](../install.md), [platform CLI](../../packages/cloudflare/src/cli/platform.ts), [deployment plan](../../packages/cloudflare/src/deploy/plan.ts), [activation](../../packages/cloudflare/src/deploy/activate.ts), [upgrade application](../../packages/cloudflare/src/upgrade/apply.ts), DESIGN §11 | Installation, environment configuration, schema evolution, maintenance activation and recovery require separate user workflows. |

### Resolutions of stale or conflicting material

These decisions govern the handbook; they do not change the product contract:

- **Use the accepted specification as the language boundary.** Internal package APIs, hand-authored JavaScript witnesses and old draft applications cannot add language features. Source investigation reveals real responsibilities and failure cases; it does not turn every implementation helper into a public construct.
- **Generation does not replace authored `When` bodies.** The incorporated [generation requirements](../specification/BUILD_GENERATION_REQUIREMENTS.md) explicitly settle Given traits/keywords and Then styles/views. Older broad language about generating scenarios must not be carried into the handbook.
- **Editor and development documentation follows the intended complete workflow.** Workspace-aware navigation/rename appears in the editor owner and LSP integration coverage despite an older document-only description. Accepted development refresh behavior belongs in local development even where a current mode is unfinished.
- **Do not promote deployment plumbing into app authoring.** Current descriptor/target/store sidecars and native/TypeScript producer boundaries are not the main public workflow. Exact deployment controls must come from accepted command/configuration owners; the rewrite must not invent convenient commands such as `can init`, `can serve`, `can migrate` or `can upgrade`.
- **Do not narrow CSV, print or UI to current implementation subsets.** Their accepted final contracts cover typed structural import, complete declared print compositions and the entire approved component catalog.
- **Keep runtime AI capabilities distinct.** Source-owned judgments, typed generation and authorized corpora are not interchangeable generic chatbot wrappers. Required corpus workflows remain in scope.
- **Localized MCP descriptions remain deferred.** DESIGN §9.1/§10 and the finished-product workflow disposition explicitly retain source-language MCP descriptions. Browser localization and localized generated application documentation have their own contracts. A broader sentence about future connection-localized metadata must not silently expand this handbook's scope.
- **Separate supported scope from product ambitions.** Do not add advanced statechart machinery, generic privileged agent execution, arbitrary app-level HTML/JavaScript, specialized visual editors or unspecified providers because a research note mentions them. Checked generated extension points remain within their accepted contracts.
- **Keep transient verification claims out of the handbook.** Old release measurements, implementation slices and current unsupported-path lists are engineering material. The public book describes the final contract; release readiness is reported separately.
