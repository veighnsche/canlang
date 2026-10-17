# Application drafts

All 39 `Can*.md` requirement documents have companion `.can` business sources using the [current language design](../DESIGN.md). Each source now declares its app name, canonical `#` description and selected packages. [Migration coverage](MIGRATION.md) records unfinished behavior and runtime requirements.

These are source-design drafts. No canlang compiler or runtime exists yet; compilation, inline examples, concurrency and acceptance journeys have not been executed. Migrating source does not establish complete requirements coverage.

The [initial parser](../tools/can_parser.py) recognized the prior 44-source corpus. The [current draft grammar](../GRAMMAR.md) adds page polling and preference-dispatched ordering; these extensions are not accepted by that unchanged syntax prototype. Earlier parser checks established syntax only. The earlier grammar round moved CanStock's executable binding and following guards into its `do` body without reordering. The frontend/i18n source round updates drafts and examples with owned English/Dutch wording, detailed groups, typed personal preferences and page-derived navigation. The task/notes reference retains its shared-message and plural example.

Built-in i18n keeps descriptions and UI text inline: `# Manage tasks. @{nl="Beheer taken."}` and `title="Tasks"@{nl="Taken"}`. Adding a language adds a keyed variant at that site. Declaration-local `label=` supplies domain captions and enum/bool labels; common shell/CRUD wording and exact identifier/type defaults remain implicit. Given `message` declarations plus existing exports/grouped imports share wording only when it is actually reused. Stored business/user text stays literal. [DESIGN §9.1](../DESIGN.md#91-built-in-internationalization) records source-language ownership, fallback/recipient semantics and unimplemented formatter/runtime work; parsing cannot certify multilingual coverage.

## Source layout

- `Can*.can` contain app identity/composition and business packages together. For example, `CanDo.can` declares `app CanDo uses=[todo]` before package `todo`.
- `shared/` retains the canonical location, employee and supplier packages. CanRent, CanOnboard and CanPurchase select their respective owning packages explicitly; other apps import them as dependencies. Shared-folder organization is deferred.
- Interfaces and payloads live in their owning packages. `export` marks the owning declaration; consumers use local imports or a bound import such as `use invoice {BillingV1 as Billing} from=deployment.billing`.
- The app-wrapper directory and authored build manifest are removed. No replacement registry or per-profile source inventory is required.

Select one app for deployment within an explicit project root. The compiler derives a declaration index and follows its `uses` composition plus package `use` dependencies. Multiple apps can be declared in the same business source; choose the app name when the entry file is ambiguous. Finding neighboring files does not include or execute their apps.

Small apps own implicit packages identified by their app names. Compose them through the same `uses` form without adding package wrappers; grouped imports name their exported owning declarations. Several implicit apps may share a file, as shown by TeamTasks, TeamNotes and their TeamOffice composition in [the task reference](../examples/TeamTasks.can). Owner identities and generated tool names stay the same standalone and composed. There is no synthetic `main` namespace or composition alias. Existing named packages retain their identities; app renames or extraction to a new package identity require explicit migration. Route/resource conflicts still need actual declaration changes rather than automatic prefixes.

Standard workerd, D1, email/password authentication, teams, daisyUI/HTMX/MCP, theme and file behavior are version-pinned defaults, so the drafts omit those setup lines. Using `file` in included runtime declarations supplies R2 automatically, with PDF/PNG/JPEG/plain-text uploads capped at 10MiB; permissions and attachment checks still apply. `context` is needed only for actual differences or named resources. The current drafts retain just the error-processing and analytics queue/telemetry contexts. Defaults also cover file fields in whole-package dependencies; no per-app copy of their setup is required.

Plain imports include canonical owning packages internally, preserving permissions, invariants, CRUD, hooks and trusted handlers. They do not automatically mount the dependency's pages or all its tools. Selected UI controls can explicitly use an imported canonical operation through the same authorized UI/MCP interface. Bound imports supply only the exported interface schemas and an external deployment binding; they never include provider execution. Imports grant visibility, not privileges.

Focused and composed apps are alternative deployments. For one operator, compose the required packages with one local owner per business record. Deploying each focused app separately would duplicate local imported owners; independently connected apps need implemented typed capabilities and identity mappings. Optional products remain optional.

## Portfolio compositions

The existing compositions are declared alongside their related business app, with no new wrapper files:

| App | Source | Selected apps |
| --- | --- | --- |
| Workspace | [CanRent.can](CanRent.can) | CanRent, CanMember, CanReport |
| CustomerSales | [CanCustomer.can](CanCustomer.can) | CanCustomer, CanCRM, CanBook, CanPropose, CanSuccess |
| Facilities | [CanMaintain.can](CanMaintain.can) | CanMaintain, CanField, CanStock |
| Finance | [CanInvoice.can](CanInvoice.can) | CanInvoice, CanExpense, CanPurchase, CanReport |
| PeopleDevelopment | [CanHire.can](CanHire.can) | CanHire, CanOnboard, CanLearn |
| StaffScheduling | [CanShift.can](CanShift.can) | CanLeave, CanShift |
| ReferralsPartners | [CanRefer.can](CanRefer.can) | CanRefer, CanAffiliate |

Composition expands member apps, deduplicates their canonical packages and merges compatible explicit context. Conflicting settings are errors; composition does not silently change business policy or provision separate databases. CanRent retains catalog, reservation, fulfillment and reporting packages. CanMember retains plans, paid terms/seats/allowances and content packages. The extra assistant-created OperatorCore shell was removed.

[WORKSPACE_OPERATOR.md](WORKSPACE_OPERATOR.md), [PORTFOLIO.md](PORTFOLIO.md) and [ADMIN_SURFACES.md](ADMIN_SURFACES.md) remain the shared business requirements. Technical configuration stays developer-provisioned; this migration adds no generic settings application.

Descriptions use `#`; ordinary comments use `##`. Inline fixtures/examples share the owning operations. The [reference examples](../examples) use the same defaults and composition rules.

`fixture receipt=file {}` provisions a pinned valid PDF through isolated upload/finalization; declare `type` or test `owner` only for differences. This is test setup, not a production file literal or an invented ID. CanExpense now checks receipt preservation and review/correction copies; CanContract checks execution and renewal with distinct old/new files. Upload policy and attachment permissions still apply. The sample provisioner and example runner remain unimplemented; see [DESIGN §5.1](../DESIGN.md#finalized-file-fixtures).

Stored models default to team ownership with `Model {...}`, while `in Parent` and `in app` remain explicit. Roles use `role Name` and retain their existing team scope and package identity. Repeated team qualifiers are invalid. These defaults do not grant access, assign roles, infer containment, or change storage placement; policies and operation authority remain explicit. Structural declarations, fixtures and value expressions keep their existing meanings.

Scalar schema fields are required/non-null without `!`; `?`, defaults and server initialization retain their meanings, and required arrays still use `[]!`. Nullable reads use `?.` and null fallback uses `??` instead of the former `coalesce` builtin. The exact precedence, evaluation and narrowing rules are in DESIGN §3.

Calendar arithmetic now adds pure anchored month addition, year/weekday extraction and bounded date ranges to the existing scheduler. CanMember derives manager-issued term boundaries from frozen calendar metadata; CanLeave derives date years and checks every requested date. Automatic renewal, availability calendars and day-price workflows still need their business rules.

`retain Model until=expr` declares owner-managed expiry without exposing cleanup CRUD or weakening locks before expiry. CanCatch separates raw files from longer-lived normalized issue history; CanStats expires event activity; CanCheck expires transitions. Physical blockers, file disposal, safe deduplication and sensitive history/receipt copies belong to the specified runtime lifecycle, which is not implemented yet.

CanDo's `form row.action` reuses a finite set of exported owner mutation schemas. Bound references carry protected records and current source authority, not editable JSON. Work projections include explicit source statuses and authorized action context; invocation feedback does not mark source work done. The source-list adapters, delegated credentials and automatic source refresh remain implementation/business work, recorded in MIGRATION.

Schema upgrades use top-level `migration Owner from="snapshot-id"` in the owning business source, with current declarations as the target. Explicit rename/drop directives and typed `backfill Model` handle the supported destructive changes; the compiler derives schemas, deployment plans and applied history. The declaration is maintenance, never a UI/MCP tool. [DESIGN §11.1](../DESIGN.md#111-schema-evolution-boundary-and-versions) gives the notation and limits. These drafts have no installed predecessor snapshots, so no real migrations or version placeholders were added to their sources. Member's historical calendar backfill still needs defensible old values, Leave's stored-year removal needs its actual old contract, and Catch's record split is outside this v1 subset.

## Frontend source contract

The [standard shell](../REQUIREMENTS.md#standard-shell-and-personal-configuration) is implicit and canonical in root requirements. App sources declare pages, groups, canonical action bindings and useful presentation preferences; no duplicate sidebar tree or base account setup. `tabs`, split collections, details drawers and filter defaults have bounded contracts in [DESIGN §9](../DESIGN.md#9-browser-presentation). Calendars remain agendas and absent business projections/providers are still gaps, not hidden behind decorative UI.

English source text and Dutch variants sit beside their declarations and uses; imported schemas carry owner labels. Each owner has an English source baseline unless its header explicitly changes `source`; viewer/app-default language never retags that source. Shared complete captions use one named `message` value. Mandatory locale-column tables and detached `for` label bindings are superseded. Outbound fixed human notices explicitly use app-default formatting, preserving their English behavior until recipient locale is supplied. Runtime catalogs, settings persistence, ICU validation/formatting, renderer/HTMX accessibility and semantic coverage checks remain unimplemented.

## Desired JavaScript examples

Twenty-one `.mjs` files are handwritten desired-output drafts with app logic, declared UI and proposed imports. [DESIGN §13](../DESIGN.md#13-desired-javascript-draft-target) defines their common metadata/component convention. The library owns daisyUI markup and HTMX behavior; app targets contain no element-tree expansion or browser business-state store. Shared implementations and owning-package generated outputs do not exist yet. Syntax checks do not execute the imports or demonstrate runtime behavior/speed.

The current semantic refinement specifies names/defaults, finite operators/builtins, BDD override conflicts, authority queries, versions, trusted rejection, recurring scope and receiving-file provenance. Frontend controls share datetime/filter/label rules; CanDo adds GET rereading and preference order without copied UI. Source-refresh delegation and several app workflows remain explicitly open in [migration coverage](MIGRATION.md). Compiler/tools/library implementation is deferred.
