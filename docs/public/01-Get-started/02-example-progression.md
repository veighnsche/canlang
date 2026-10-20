# Find a complete CanLang example

Start with Tasks, follow an expense through submission and review, then explore focused interface, integration and generation examples. Choose a complete application or a fragment with its dependencies clear.

## Choose a complete example by task

Each row links the instructions and canonical downloadable source. Keep examples in separate directories unless the row explicitly describes a multi-file project. Similar app names do not make independent examples interchangeable.

| Task | Guide | Complete source and prerequisites |
| --- | --- | --- |
| Learn records and guarded changes | [First app](05-first-app.md), [first workflow](07-first-workflow.md) | Complete replacement source appears in each tutorial; local team, no provider. |
| Approve expenses | [Approval recipe](../10-Recipes/01-approval-workflow.md) | [ExpenseFlow.can](../examples/recipes/ExpenseFlow.can); separate requester/reviewer. |
| Reserve a single-capacity resource | [Booking recipe](../10-Recipes/02-resource-booking.md) | [Bookings.can](../examples/recipes/Bookings.can); manager and member. |
| Schedule task escalation | [Reminder recipe](../10-Recipes/03-reminders-and-escalation.md) | [Reminders.can](../examples/recipes/Reminders.can); scheduler-enabled test environment. |
| Review external name changes | [External sync recipe](../10-Recipes/04-external-sync.md) | [ExternalSync.can](../examples/recipes/ExternalSync.can); synchronizer/reviewer, manual synthetic intake first. |
| Explore pages and collections | [Collections](../07-Build-interfaces/03-collections-and-views.md) | [TaskPages.can](../examples/task-pages/TaskPages.can); local team. |
| Bind forms and dependent choices | [Forms](../07-Build-interfaces/04-forms-and-inputs.md) | [TaskForms.can](../examples/task-forms/TaskForms.can); local team. |
| Compose components | [Components](../07-Build-interfaces/02-components-and-layout.md) | [ComponentTasks.can](../examples/component-tasks/ComponentTasks.can); local team. |
| Save preferences and localize messages | [Preferences](../07-Build-interfaces/05-settings-and-preferences.md), [localization](../07-Build-interfaces/06-localization.md) | [TaskPreferences.can](../examples/task-preferences/TaskPreferences.can); separate [TaskMail.can](../examples/task-preferences/TaskMail.can) requires mail binding. |
| Import/export tasks and call them over MCP | [CSV import](../07-Build-interfaces/07-csv-import.md), [MCP](../08-Connect-services/07-mcp.md) | [InterfaceTasks.can](../examples/interface-tasks/InterfaceTasks.can), [tasks.csv](../examples/interface-tasks/tasks.csv); file-capable runtime for attachments. |
| Fetch a remote account durably | [Service walkthrough](../08-Connect-services/01-contracts-and-service-bindings.md) | [Accounts.can](../examples/account-lookup/Accounts.can) + [Lookup.can](../examples/account-lookup/Lookup.can); implement and bind the declared provider contract. |
| Upload and attach a file | [Files](../08-Connect-services/03-files-and-attachments.md) | [ReceiptFiles.can](../examples/files-mail-payments/ReceiptFiles.can); file-capable runtime. |
| Receive and review mail replies | [Email](../08-Connect-services/04-email-and-mailboxes.md) | [MailReplies.can](../examples/files-mail-payments/MailReplies.can); mailbox binding and agent role. |
| Collect and refund a payment | [Payments](../08-Connect-services/05-payments.md) | [PaymentDemo.can](../examples/files-mail-payments/PaymentDemo.can); test payment provider and finance role. |
| Review generated text | [Reviewed AI recipe](../10-Recipes/05-reviewed-ai-actions.md) | [TextReview.can](../examples/runtime-ai/TextReview.can); text-generation binding/profile. |
| Validate an image workflow and generate | [Runtime generation](../09-Runtime-AI/01-text-and-image-generation.md) | [ImageReview.can](../examples/runtime-ai/ImageReview.can); image provider, real workflow graph and designer role. |
| Evaluate static or runtime choices | [Judgments](../09-Runtime-AI/02-judgments.md) | [JudgmentReview.can](../examples/runtime-ai/JudgmentReview.can); judgment binding. |
| Ask a protected corpus | [Private knowledge recipe](../10-Recipes/06-private-knowledge-assistant.md) | [KnowledgeReview.can](../examples/runtime-ai/KnowledgeReview.can); corpus binding, editor and designated reader. |
| Compose task and note packages | [Composed-app recipe](../10-Recipes/07-composed-business-app.md) | [Office.can](../examples/team-office/Office.can) + [Tasks.can](../examples/team-office/packages/Tasks.can) + [Notes.can](../examples/team-office/packages/Notes.can); preserve the directory layout. |
| Run behavioral examples | [Fixtures and sequences](../11-Verify-and-build/02-fixtures-and-examples.md) | [VerifiedTasks.can](../examples/verified-tasks/VerifiedTasks.can); fixture users differ from preview actors. |
| Look up builtin usage | [Types and builtins](../13-Language-reference/02-types-and-builtins.md) | [BuiltinLookup.can](../examples/builtin-lookup/BuiltinLookup.can); worked expressions in an app context. |

For `$` generation, use the complete [PromptStudio project](#extend-an-app-with-dollar-prompts), including its saved implementation and acceptance files. The guides own setup and verification; the `.can` links supply source, not provider accounts or preview data.

## Start with Tasks

Use one small application to learn the relationship between `Given`, `When` and `Then` before adding business-specific behavior.

| Stage | Source and form | What to learn |
| --- | --- | --- |
| Create and manage tasks | [First app](05-first-app.md): complete `Tasks` source | A stored `Todo`, a read policy, permitted CRUD fields, an inline form and an authorized list |
| Complete a task explicitly | [First workflow](07-first-workflow.md): complete replacement `Tasks` source | A guarded operation, a server-recorded completion time, and examples of success, forbidden access and stale versions |
| Add useful presentation | [Todos source](https://github.com/veighnsche/canlang/blob/main/examples/Todo.can): complete application named `Todos` | Field labels, validation, a persisted view preference, filtering and search |

The first-workflow listing replaces the first-app listing; do not append a second `app Tasks` declaration to the same source. Its added field also changes the stored schema: use [schema migrations](../12-Deploy-and-operate/03-schema-migrations.md) when applying the change to an existing installation.

`Todos` is a separate application, not an automatic upgrade of `Tasks`. Its source file is named `Todo.can`; the application name to select is `Todos`. For preview and execution prerequisites, use [local development](06-local-development.md).

After Tasks, choose the expense workflow below or go directly to [generation with dollar prompts](#extend-an-app-with-dollar-prompts).

## Follow an expense through a business workflow

[ExpenseFlow source](../examples/recipes/ExpenseFlow.can) supplies a complete application containing the `expenses` and `reporting` packages. Read it in this order:

1. Follow `Expense.submitted_by` from the authenticated requester to the policies that select visible expenses. Compare the requester's own-record access with the declared `reviewer` role.
2. Trace draft submission, approval and rejection. Inspect the amount invariant, locks after submission, and the rule preventing self-approval.
3. Follow `decided_by` and `decided_at` to the recorded review decision. Compare successful, forbidden, invalid-state and stale-version examples.
4. Read the reporting package's import of `Expense`, currency-filtered query and typed `Summary` result.
5. Connect those operations to the form, list, decision dialogs and report page.

This example teaches relationships to people, explicit authority, exact money and a business lifecycle in one source file. It also shows package composition without requiring an external service. Continue with the complete [ExpenseData companion app](../04-Model-and-query-data/01-models-and-relationships.md) to compare cost-centre references, contained expense lines, contract values, unions and arrays. It is a separate data-modeling application; do not append its declarations to ExpenseFlow. Follow [defaults and validation](../04-Model-and-query-data/02-defaults-and-validation.md) for normalization, server-owned values and composite uniqueness.

The [approval recipe](../10-Recipes/01-approval-workflow.md) supplies a complete ExpenseFlow source with requester/reviewer setup and verification. Supporting files and notifications remain separate integrations.

For a complete permission-focused companion, follow [ExpenseReview](../05-Permissions-and-policy/01-authentication-and-teams.md). Its five-part lesson connects team membership, reviewer assignment, private notes, finance reports, invariants and locks using one source listing and an allowed/refused walkthrough.

## Explore interfaces and composition

These examples build on ordinary records and operations. Choose the example for the interface behavior you need.

| Example | Form and dependencies | What to inspect |
| --- | --- | --- |
| [TeamTasks, TeamNotes and TeamOffice](https://github.com/veighnsche/canlang/blob/main/examples/TeamTasks.can) | Complete multi-app source; keep all declarations. `TeamNotes` imports messages from `TeamTasks`; `TeamOffice` composes both. | Member assignment, preferences, translated messages, shared labels and composed navigation |
| [ActionForms](https://github.com/veighnsche/canlang/tree/main/tests/fixtures/action-forms) | Complete application source with its browser-check configuration | Inline forms, canonical create/edit dialogs, `primary` submit controls and preserved input |
| [ActionGallery](https://github.com/veighnsche/canlang/tree/main/tests/fixtures/action-gallery) | Complete application source with its browser-check configuration | `primary` and `secondary` actions on pages, cards, rows, split details, modals and drawers |

The `app TeamOffice uses=[TeamTasks,TeamNotes]` line is a **composition declaration**. Copying that line alone omits its two dependencies. Keep the complete source or supply both owning applications.

For a complete directory-based example, follow [multi-file composition](../02-Language-foundations/04-apps-and-packages.md). Its separate three-file `TeamOffice` project uses explicit task and note packages, aliased imports and a call to the task owner’s completion operation. Keep it separate from the localization example above, which uses the same app names for a different teaching stage.

ActionForms and ActionGallery use shared interface behavior without generated styles or external providers. Their authored fixtures exercise operations; they do not populate the browser preview. Create sample records through the app when inspecting its screens.

## Extend an app with dollar prompts

Use [PromptStudio](https://github.com/veighnsche/canlang/tree/main/tests/fixtures/prompt-pipeline) for build-time generation. It is a complete application project: keep `PromptStudio.can`, its saved `can.generated/` implementation, generation settings and browser-check files together.

Read the source in four parts:

1. Named and inline model/field traits use `$"..."` prompts. Named traits apply by their bare name.
2. A typed custom keyword declares reusable behavior and receives explicit named arguments.
3. A named style is declared with `$"..."` and reused with `$Surface`; an inline component prompt styles one declaration.
4. A row-bound view uses a renderer prompt and preserves the source-owned card and its canonical actions.

Follow the [complete generation tutorial](../03-Generate-implementation/01-generation-lifecycle.md) to set up this project, generate and accept implementation, edit saved files, refine a unit and recover interrupted work. Use [traits and custom keywords](../03-Generate-implementation/02-traits-and-custom-keywords.md), [styles and custom views](../03-Generate-implementation/03-styles-and-custom-views.md), and [generation configuration](../15-Tooling-reference/03-generation-configuration.md) for the detailed rules. Ordinary builds consume saved implementation. Explicit generation requires a configured, authenticated coding runner; its output must pass the generation acceptance process.

[Generation.can](https://github.com/veighnsche/canlang/blob/main/examples/Generation.can) has a different purpose: its application is named `Generation`, and it demonstrates a `Job` state machine with queue/start/fail/retry/finish operations and a polling page. It contains neither `$` prompts nor a model-provider call. Use it with [state machines](../06-Business-workflows/04-state-machines.md), not as the generation setup tutorial.

## Study focused integration applications

Use the smaller downloadable examples above first. The following larger projects are advanced reading, not prerequisites for those recipes. Start this branch after understanding scenarios, record relationships and [delivery outcomes](../08-Connect-services/02-deliveries-and-recovery.md). Each application demonstrates a focused integration workflow. Supply its declared service bindings and credentials when running it.

| Example and form | Required supporting environment | Focused reading path |
| --- | --- | --- |
| [CanChat](https://github.com/veighnsche/canlang/tree/main/draft/apps/CanChat): complete application source with external dependencies | Saved style, the standard text-generation contract bound through `deployment.llm`, and finalized files for attachments | Freeze a typed request → send → display progress → retain the result → cancel or reconcile |
| [CanSync](https://github.com/veighnsche/canlang/tree/main/draft/apps/CanSync): complete application source with external dependencies | Saved style and `deployment.accounts`, implementing its declared `AccountsV1` contract | Read a remote account → store its delivery and observation → propose a correction → review → reconcile a conditional write |
| [CanKnowledge](https://github.com/veighnsche/canlang/tree/main/draft/apps/CanKnowledge): complete application source with external dependencies | Saved style, `deployment.knowledge`, and corpus/file processing | Publish a reviewed revision → establish corpus eligibility → ask a private question → display authorized evidence |

Keep each owning project together when running or adapting its source. A copied `send` line is a fragment: it depends on its imports, typed input, operation authority and stored delivery association. Read one workflow first instead of treating the entire application as a beginner exercise.

Use the [service-binding guide](../08-Connect-services/01-contracts-and-service-bindings.md) for contracts, [runtime generation](../09-Runtime-AI/01-text-and-image-generation.md) for provider requests and [knowledge corpora](../09-Runtime-AI/03-knowledge-corpora.md) for authorized retrieval.

## Know what an example includes

| Form | How to use it |
| --- | --- |
| Complete application source | All local declarations for the named app are present. Keep stated imports, dependencies and project files; source completeness alone does not establish a working deployment. |
| Complete replacement source | Replace the earlier tutorial version. Preserve existing data through the applicable schema-change workflow. |
| Source fragment | Place it in the stated `Given`, `When` or `Then` context and supply every referenced model, role, binding and value. It is not a standalone file. |
| Composition declaration | Supply each named application/package. The declaration selects owners rather than reproducing their contents. |
| Design outline | Use it to understand a workflow's requirements. It does not supply executable source or a finished setup procedure. |

Use the [business recipes](../10-Recipes/01-approval-workflow.md) to connect language features to application workflows. Reference header patterns are schematic: placeholder names and optional-syntax notation must be replaced with actual declarations.

An `examples` block inside a Can file has another specific meaning: it declares behavioral checks for an operation. See [fixtures and examples](../11-Verify-and-build/02-fixtures-and-examples.md) to distinguish those checks from the surrounding application and its browser setup.
