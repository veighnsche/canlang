# Public handbook filetree

This file records the source-informed structure and page ownership of the public application-author handbook for the intended finished CanLang product. The 86 pages replace the 13 legacy chapters.

The handbook should teach people and coding agents to create, understand, verify and operate company applications. Its contents describe the accepted product contract, including required capabilities that remain unfinished. Implementation status, compiler repair work, internal package allocation and release qualification stay in engineering documentation. Writing the finished-product handbook does not assert that the current release implements every described capability.

## Organization

The handbook has **86 public pages in 12 sections**. Use product topics for the main chapters, a short guided start, joined business recipes, and a compact reference at the end. `Given`, `When` and `Then` explain how source is written; they are not the whole navigation system. For example, uploading an attachment spans data, forms, storage and authorization, but a reader needs one place explaining that journey.

Each topic has one explanatory home. Tutorials and recipes apply those concepts; reference pages supply exact syntax, signatures and limits. Cross-links connect these uses without creating competing descriptions of the same rule.

Keep the existing publication format: two levels of numbered folders/pages, globally unique page slugs, and exactly one `index` page. The website uses flat `/docs/canlang/<slug>` routes, so reorganizing a section need not rename its page URLs. Keep this format when adding or moving pages.

## Complete handbook tree

The comments below specify what each page owns. `README.md` and this file are authoring material and remain outside the numbered public export.

```text
docs/public/
├── README.md                                  # Handbook authoring and publication contract.
├── FILETREE.md                                # Source-informed page ownership; not a public page.
│
├── 01-Start-here/
│   ├── 01-index.md                            # What CanLang builds, its model, scope and reading paths.
│   ├── 02-installation.md                     # Install, verify, update and select a toolchain version.
│   ├── 03-first-app.md                        # A complete small app: records, permissions, CRUD and page.
│   ├── 04-first-workflow.md                   # Add a guarded business action and independent examples.
│   └── 05-ai-authoring.md                     # Work with a coding agent; review intent, authority and outcomes.
│
├── 02-Language/
│   ├── 01-source-syntax.md                    # Layout, sections, names, literals, comments and source fragments.
│   ├── 02-apps-and-packages.md                # Identity, implicit/explicit packages, composition, imports and defaults.
│   ├── 03-types-and-values.md                 # Scalars, enums, arrays, contracts, unions, references and opaque values.
│   ├── 04-expressions-and-derives.md           # Scope, operators, narrowing, evaluation order and reusable pure helpers.
│   └── 05-descriptions-and-app-reference.md    # Attached descriptions, reusable prose and generated application docs.
│
├── 03-Data/
│   ├── 01-models-and-relationships.md         # Stored records, team/app/parent ownership, references and uniqueness.
│   ├── 02-defaults-and-validation.md          # Omission, null, defaults, server fields, constraints and field-type reuse.
│   ├── 03-queries-and-aggregates.md           # Typed queries, aliases, filters, ordering, groups and reporting.
│   ├── 04-money-and-currency.md               # Exact amounts, rounding, snapshots and explicit currency boundaries.
│   ├── 05-dates-and-timezones.md              # Civil dates, instants, durations, DST and anchored calendar arithmetic.
│   └── 06-history-and-retention.md            # Audit history, archival, locks, logical expiry and eventual disposal.
│
├── 04-Access-and-rules/
│   ├── 01-authentication-and-teams.md         # Accounts, verified identity, recovery, invitations, membership and contexts.
│   ├── 02-roles-and-operation-permissions.md  # Roles, current caller, by clauses, eligibility and explicit exposure.
│   ├── 03-read-policies-and-field-access.md   # Row/leaf grants, readable dependencies, related data and safe projections.
│   ├── 04-invariants-and-locks.md             # Final-state constraints and protected pre-state across all writes.
│   └── 05-reviewing-business-policy.md        # Review source-derived access and business rules with company stakeholders.
│
├── 05-Workflows/
│   ├── 01-crud-and-record-lifecycle.md        # Canonical create/update/delete, allowlists, archive and explicit removal.
│   ├── 02-scenarios-and-effects.md            # Typed operations, ordered guards/do, effects, results and bounded control flow.
│   ├── 03-transactions-and-concurrency.md     # D1/per-root Durable Object authority, atomicity, versions, replay and pending work.
│   ├── 04-state-machines.md                   # Stored lifecycle states and operation-owned transition edges.
│   ├── 05-events-and-hooks.md                 # Precommit hooks, committed events, typed queue consumers and trusted handlers.
│   ├── 06-scheduling-and-recurring-work.md    # Schedule/cancel, record revisions, current eligibility and recurrence.
│   ├── 07-fanout-and-batch-work.md            # Complete finite cohorts, per-child commits, progress and durable recovery.
│   └── 08-actions-and-invocations.md          # Typed operation references, protected bindings and complete reviewed calls.
│
├── 06-Interfaces/
│   ├── 01-pages-and-navigation.md             # Routes, page admission, derived navigation and the shared application shell.
│   ├── 02-collections-and-views.md            # Collections, row scope, filters, paging, details and ordinary reusable view/show.
│   ├── 03-forms-and-inputs.md                 # Owner-derived forms, input placement, reference selection and conflict recovery.
│   ├── 04-components-and-layout.md           # Component composition, slots, bindings, accessibility and responsive behavior.
│   ├── 05-settings-and-preferences.md         # Shared account settings and typed self-only presentation preferences.
│   ├── 06-localization.md                    # Inline translations, messages, labels, ICU, fallback and outbound wording.
│   ├── 07-live-pages-and-progress.md          # Authorized polling, explicit refresh, async status and preserved drafts/focus.
│   ├── 08-csv-import.md                       # Typed mapping, review/preview, consent, per-row execution and partial failures.
│   ├── 09-export-and-print.md                 # Authorized complete exports/print, limits, exact values and protected downloads.
│   └── 10-mcp.md                             # Connect a chatbot; shared tools, user/team grants, calls and file handoff.
│
├── 07-Integrations/
│   ├── 01-contracts-and-service-bindings.md   # Finite capabilities, versioned bindings and public-only reconstructible KV caching.
│   ├── 02-deliveries-and-recovery.md          # Durable sends/typed queues, receipts, progress, retries and uncertain outcomes.
│   ├── 03-files-and-attachments.md            # Upload/finalize/attach/download, immutable content, provenance and file lifetime.
│   ├── 04-email-and-mailboxes.md              # Notifications, frozen recipients/content, verified intake and reviewed replies.
│   ├── 05-payments.md                        # Consent, collect/refund/cancel, verified events and uncertain settlement.
│   ├── 06-external-data-and-app-connections.md # Explicit source mappings, cross-app identity, revisions and reconciliation.
│   ├── 07-text-and-image-generation.md        # Runtime model requests, typed outputs, budgets, progress and confirmed completion.
│   ├── 08-judgments.md                        # Authored NOUL/choice/score questions, candidates, distributions and review.
│   ├── 09-knowledge-corpora.md                # Authorized source revisions, indexing coverage and private grounded answers.
│   └── 10-instrumentation.md                  # Analytics declarations, error/usage/health intake, consent, limits and retention.
│
├── 08-Code-generation/
│   ├── 01-generation-lifecycle.md             # Explicit generation, selected scope, saved implementations and zero-AI builds.
│   ├── 02-traits-and-custom-keywords.md       # Given model/field extensions and named standalone implicit declarations.
│   ├── 03-styles-and-custom-views.md           # Named/inline styles, reusable row-bound renderers and canonical controls.
│   └── 04-editing-and-refinement.md           # Direct editing, refinement, full retry, leases, promotion and interrupted work.
│
├── 09-Development/
│   ├── 01-local-development.md               # Terminal development, checks, protected preview, refresh and retained local state.
│   ├── 02-editor-support.md                  # Extension setup, project diagnostics, completion, navigation and safe rename.
│   ├── 03-diagnostics-and-help.md             # Understand failures, source locations, construct help and corrective feedback.
│   ├── 04-fixtures-and-examples.md            # Real fixture setup, example tables, sequence journeys and exact expectations.
│   ├── 05-workflow-and-interface-testing.md   # Verify real actors, browser/MCP, files, conflicts, retries and external outcomes.
│   ├── 06-builds-and-validation.md            # Check, emit, validate and build the selected app with compatible saved code.
│   └── 07-continuous-integration.md           # Application checks/examples/acceptance in CI without implicit generation.
│
├── 10-Deployment/
│   ├── 01-deploying-an-app.md                 # Select an app, prepare/review a release, deploy and verify its actual outcome.
│   ├── 02-environments-and-secrets.md         # Resource provisioning, environment bindings, provider accounts and server secrets.
│   ├── 03-schema-migrations.md               # Exact predecessors, explicit renames/drops/maps and complete data validation.
│   ├── 04-upgrades-and-recovery.md            # Maintenance, old work, resumable staging, activation and recovery boundaries.
│   └── 05-operating-an-app.md                 # Inspect pending work, failures, limits, retention and supported recovery actions.
│
├── 11-Recipes/
│   ├── 01-approval-workflow.md                # An expense/file submission with distinct review and immutable evidence.
│   ├── 02-resource-booking.md                 # Capacity, interval conflicts, exact prices and recoverable coordination.
│   ├── 03-reminders-and-escalation.md          # Revision-bound reminders that stop when business state changes.
│   ├── 04-external-sync.md                    # Review imported facts, compare revisions and reconcile duplicates/conflicts.
│   ├── 05-reviewed-ai-actions.md              # Propose typed work, inspect the full change and explicitly authorize execution.
│   ├── 06-private-knowledge-assistant.md       # Publish sources, answer with evidence and handle subsequent access revocation.
│   └── 07-composed-business-app.md            # Combine independently owned apps while retaining identities and permissions.
│
└── 12-Reference/
    ├── 01-cli.md                              # Command syntax, inputs, outputs, mutations and exit behavior.
    ├── 02-development-controls.md             # Machine-readable dev controls, source revisions, session and preview contracts.
    ├── 03-generation-controls.md              # Generation requests/status, scope, leases, recovery and result contracts.
    ├── 04-generation-configuration.md         # can.gen.toml, runner/model profiles, precedence and execution limits.
    ├── 05-context-and-defaults.md              # Context, database/binding/queue/cache/analytics, inherited defaults and conflicts.
    ├── 06-syntax-reference.md                 # Source construct index and concise exact forms linked to owning definitions.
    ├── 07-types-and-builtins.md                # Source-visible types, constraints, operators and pure builtin signatures.
    ├── 08-service-contracts.md                 # Accepted standard capabilities, request/result/event shapes and limits.
    ├── 09-components-layout-and-navigation.md # Layout and authorized destination components.
    ├── 10-components-content-and-feedback.md  # Readable content, decoration, metrics and actual feedback components.
    ├── 11-components-inputs.md                 # Existing typed input bindings, labels and validation outlets.
    ├── 12-components-disclosure-and-actions.md # Local panels, disclosures, menus and canonical action bindings.
    ├── 13-components-collections-and-media.md # Collection, pagination and authorized media components.
    └── 14-errors-and-wire-values.md            # Safe errors, exact encodings, operation envelopes and compatibility.
```

## Boundaries that make this structure useful

| Question | Primary home | Related pages do something different |
| --- | --- | --- |
| What does a type mean? | Language: types and values | Data explains storage/input use; Reference gives complete signatures and representations. |
| Who may do what? | Access and rules | CRUD/scenario chapters apply the policy; interface chapters show it without redefining authority. |
| Will this business change happen atomically? | Workflows: transactions and concurrency | Deliveries explains persisted external intent and uncertain provider outcomes; upgrades explains maintenance across owners. |
| What happens to a record or file over time? | Data: history and retention | CRUD owns archive/remove; Files owns actual byte custody and finalization; Operations explains disposal/failure visibility. |
| How does background work run? | Workflows: scheduling and fanout | Deliveries owns transport attempts; live pages owns displaying progress; recipes join them. |
| What is an action versus an invocation? | Workflows: actions and invocations | Forms consumes protected action bindings; reviewed-AI recipes apply complete calls; MCP explains their transport. |
| How do I build a page? | Interfaces | Component reference supplies exact finite contracts; generated views extend checked presentation under the same rules. |
| Where do native resources belong? | Transactions owns D1/per-root authority; deliveries/events owns typed queues; service bindings owns public KV caching; instrumentation owns analytics | Context reference gives exact declarations; environments explains provisioning. A cache or telemetry stream cannot become business authority. |
| How do I call AI from my app? | Integrations: text/image generation, judgments, corpora | Code generation concerns saved implementation produced before deployment. |
| How do I change generated implementation? | Code generation: editing and refinement | Configuration/controls are exact lookup; ordinary build and CI reuse accepted saved code. |
| How do I prove my business rules? | Development: fixtures and examples | Workflow testing checks joined user journeys; tutorials introduce one short example; no duplicate test language. |
| How do I change an installed application? | Deployment: schema migrations and upgrades | Installation updates the local toolchain; app release compatibility is handled with the app's data and pending work. |
| Where do I look up a declaration? | Reference: syntax/types/components/services | Tutorials teach; compiler-owned construct help and owning catalogs remain the authorities. |

Cross-cutting guarantees should be taught at the point they matter and linked to their owner: denial does not leak records; a hidden control is not permission; a transport receipt is not a business result; cancellation is not confirmed termination; and an operation accepted at one owner is not an atomic commit across services.

### Component reference allocation

The approved vocabulary contains 68 components. Allocate all of them to the five reference pages, rather than limiting the handbook to components found in the first example app or creating 68 small pages.

| Reference page | Component words |
| --- | --- |
| Layout and navigation | `breadcrumbs`, `card`, `divider`, `dock`, `footer`, `hero`, `join`, `link`, `megamenu`, `menu`, `navbar`, `stack`, `tabs` |
| Content and feedback | `alert`, `aura`, `badge`, `chat_bubble`, `countdown`, `diff`, `hover_3d`, `indicator`, `kbd`, `loading`, `mask`, `mockup_browser`, `mockup_code`, `mockup_phone`, `mockup_window`, `progress`, `radial_progress`, `skeleton`, `stat`, `status`, `steps`, `swap`, `text_rotate`, `timeline`, `toast` |
| Inputs | `calendar` (date control), `checkbox`, `fieldset`, `file_input`, `filter`, `input`, `label`, `otp`, `radio`, `range`, `rating`, `select`, `textarea`, `theme_controller`, `toggle`, `validator` |
| Disclosure and actions | `accordion`, `button`, `collapse`, `drawer`, `dropdown`, `fab`, `modal`, `tooltip` |
| Collections and media | `avatar`, `carousel`, `hover_gallery`, `list`, `pagination`, `table` |

Canonical constructs such as `page`, `form`, `action`, `primary`, `secondary`, `edit`, `delete`, `copy`, `details`, `history`, `board`, `gallery`, `metrics`, `view` and `show` remain documented with their semantic owner and indexed in syntax reference. The agenda form of `calendar` belongs in collections/views and links to its distinct header; it must not be confused with a date input. The approved component catalog supplies the exact contexts, slots, types and options.

Shared accessibility, escaping, focus, responsive behavior and reduced-motion rules live in components/layout. Component entries explain their particular binding and interaction requirements. No component creates its own permission model, schema or business operation.

Ordinary reusable `view`/`show` composition is taught in collections/views without requiring generation. The Code generation chapter covers the additional prompt-rendered view and saved-asset lifecycle.

### Reading paths

- **First application:** Start here → source/packages → models → access → CRUD/scenarios → forms/pages → examples → local development → deployment.
- **Business rule change:** policy review → relevant data/rule/scenario → examples → current authorization/version behavior → build → migration/upgrade when needed.
- **Integration:** contracts/bindings → deliveries → the relevant provider/file/AI topic → real failure examples → environment setup.
- **Custom generated behavior or presentation:** generation lifecycle → Given extensions or Then styles/views → refinement → validation → saved-code build.
- **Operator:** environments → deploy → pending work and failures → history/retention → migrations/upgrades/recovery.
- **Returning author or agent:** exact reference/construct help → owning explanation → a joined recipe where useful.

The complete reference is for lookup. A novice should not have to read every component, service or command before making the first app.

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

## Replaced legacy pages

The legacy chapters have been replaced by the owners below. The first-app and first-workflow tutorials provide the common learning spine; the seven recipes teach joins beyond that spine. Other chapters use focused fragments with explicit prerequisites.

| Existing page | Successor allocation |
| --- | --- |
| `01-Getting-started/01-index.md` | `01-Start-here/01-index.md`; preserve the landing route. |
| `01-Getting-started/02-installation.md` | Installation only in `01-Start-here/02-installation.md`; app tutorial moves to `03-first-app.md`. |
| `01-Getting-started/03-contributor-setup.md` | Remove from the public authoring path; use existing [developer setup](../dev-setup.md) for compiler contributors. |
| `02-Language/01-source-and-composition.md` | Language source syntax, apps/packages, and context/default reference. |
| `02-Language/02-data-and-queries.md` | Language types plus the complete Data section. |
| `02-Language/03-permissions.md` | Access and rules; lifecycle/atomicity examples link to Workflows. |
| `02-Language/04-workflows.md` | Workflows; delivery/recovery moves to Integrations; examples to Development. |
| `02-Language/05-interfaces.md` | Interfaces plus the five component reference pages. |
| `02-Language/06-services-and-generation.md` | Integrations and Code generation, with separate reference owners. |
| `03-Build-and-operate/01-local-development.md` | Development local workflow, editor and machine controls. |
| `03-Build-and-operate/02-testing.md` | Fixtures/examples, workflow/interface testing and application CI. |
| `03-Build-and-operate/03-deployment.md` | Deployment, environments, migrations, upgrades and operation. |
| `04-Reference/01-cli.md` | Command reference; detailed control/configuration/wire references become separate pages. |

Preserve existing stable website slugs `index`, `installation`, `local-development` and `cli`. The eventual website snapshot should redirect retired public routes to the appropriate starting successor: `source-and-composition` → `apps-and-packages`, `data-and-queries` → `models-and-relationships`, `permissions` → `roles-and-operation-permissions`, `workflows` → `scenarios-and-effects`, `interfaces` → `pages-and-navigation`, `services-and-generation` → `contracts-and-service-bindings`, `testing` → `fixtures-and-examples`, and `deployment` → `deploying-an-app`. The former contributor route should point to contributor documentation. These are website follow-ups, not redirect files to invent inside this Markdown export.

Current links in the repository [README](../../README.md) and [installation guide](../install.md) point to the new owners. Preserve historical decision records rather than rewriting them to imply the old structure never existed.

## Maintaining the handbook

Update a concept's explanatory owner when its accepted contract changes, then correct the affected tutorials, recipes and reference entries. Keep implementation-status reporting outside the public export. Check local links and anchors, global slug uniqueness, complete component coverage and runnable examples at their actual scope. A current unsupported implementation path does not authorize changing accepted final semantics.

The website snapshot and its route redirects are maintained by the publishing website. Documentation edits do not publish, deploy or change runtime behavior.
