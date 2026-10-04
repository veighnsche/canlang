# Preserved selected context — Variant C initial attempt

Context is a reproducible selected subset of documentation observed during retrieval. Full-file read commands for REQUIREMENTS/DESIGN/GRAMMAR produced truncated outputs; this record does not claim that all their bytes were model context. Additional rg line searches located relevant sections and the parser entry point. No findings/reports, other variant artifacts, or proposed remediation were read.

## AGENTS.md:1–9

```text
# Working on Can

- Prioritize the user's requirements, adoption, simplicity, and token efficiency. Keep design assumptions open to revision.
- Express app identity and composition in `.can` source. Derive dependencies and interfaces from owning declarations; use shared defaults and reusable components to keep authoring concise.
- Address missing capabilities in the language design while preserving complete workflows, edge cases, permissions, and evaluation order. Use `##` for explanatory comments and keep executable bindings inside `do`.
- Make focused changes and run checks appropriate to them. Preserve inline behavior examples and report what was verified, what remains proposed, and any gaps.
- Evaluate alternatives fairly against the same outcomes and evidence. Assess draft designs at their declared stage, distinguishing desired generated output from implemented APIs.
- For difficult design decisions, consult JEV with verified context and balanced alternatives. Calls are preauthorized. Use the appropriate question type and three independently worded, equivalent requests; save responses and uncertainty, investigate disagreement, and treat results as advice.
- Keep work moving with reasonable implementation choices. Delegate independent work when useful, with focused context.
```

## design/evaluation/evidence/adoption/experiment-protocol.md:1–29

```text
# Pinned bounded AI experiment protocol

Pinned 2026-10-04 before generation. Owner A. Stage: draft authoring and static review, no Can/compiler/library implementation. Company P and J1–J4 from journeys.md are the common outcomes. Frozen baseline plus B rules.md are source authority. Neither a handwritten MJS target nor structural parse establishes execution. Conventional alternative uses existing Django framework/shared components, not a custom framework. Generation subject must preserve all attempts, files, assumptions and limitations under experiments/; findings are reviewed by A/B/C. No live source changes.

## First-app request, identical business requirements for both variants

Generate the smallest COMPLETE departmental equipment-request application for a hypothetical 25-person professional-services company. Staff use browser forms and an authorized MCP chatbot; staff will not author source. Email/password login, one company team, 3 departments with current employee membership, owner-only private request access, department managers see only their departments, and operation reviewers/finance do not gain unrelated scope. An employee creates a trimmed nonempty title and optional note, may update or archive their own unresolved request, and a manager can see department requests but cannot silently change employee claims. Request owner and department derive from the current authorized principal, never client-supplied escalation. Ordinary request state is open or archived; archive preserves evidence; stale updates return conflict. Data scale 500 records, 25 users. A table/list with search/filter, create/edit/archive, accessible outcome/errors and narrow-screen support is required. Authorized CSV export and CSV intake with invalid/duplicate row preview and explicit correction/exclusion/partial per-row outcomes must retain access rules. Browser/MCP reuse one server-owned business operation, version checks and disclosure; no duplicated policy or different mutation API. Include independently authored behavior expectations for create, own update, other employee denial, manager scope, invalid title, archive, scoped export and partial import. Do not invent extra purchasing, approvals, providers or actual migration history. Explicitly record reasonable inferred policy and missing information. Produce only the necessary app-specific source, necessary wiring/settings notes and reviewable behavior; shared platform/framework code is assumed provided only where its actual contract is named. This is a draft comparison, not a claim of execution.

## Variant C — Can

Use frozen REQUIREMENTS/DESIGN/GRAMMAR and examples/TeamTasks plus B rules.md. Relevant defaults are version-pinned authentication/teams/storage/UI/MCP, team-owned models, # description, ## comments, bindings inside do, invariant for Given constraints and require for guards; app identity/composition in .can. Canonical CRUD/form/CSV and shared runtime mechanisms must retain business choices. Save C/initial.can, supplied-docs.json (paths/bytes), assumptions.md and available timing/usage metadata. Do not add a library implementation, MJS target or redesign grammar.

## Variant D — Django

Use Django 5.2 auth, ORM, ModelForm, templates and shared transaction/validation facilities with current official documentation; use the official MCP Python SDK transport as a thin adapter to the same operation. Use Django's efficient normal authoring boundaries. Shared auth/schema/form libraries are reuse, not charged as per-app code. Save D/initial/ app-specific models/forms/service/views/templates/tests and necessary settings/wiring notes, supplied-docs.json and available timing/usage metadata. Do not build an application platform. If a required interface requires app-specific glue, retain/count that code rather than assume it generated.

## Common assistance and stopping rule

One initial attempt each; same subject model and effort, complete brief and relevant docs available, no external live-data access. Subject may read/search documentation and use existing structural checks. After independent static review, at most one repair turn each with comparable acceptance feedback; preserve original and repaired outputs and all feedback. An attempt can be incomplete; do not repair invisibly. No extra bespoke repairs to favor Can. Familiarity/tooling differ and will be reported. Wall time and visible saved prompt/source tokens are observed where available; internal model reasoning, hidden dispatcher context and actual billing totals are unavailable unless returned. No statistical reliability or market inference from one matched pair.

## Later changes, normal efficient edits under same outcomes

1. Ordinary rule: rename equipment title presentation to Request; archive requires a nonempty reason while preserving state/version rules.
2. Data: add optional cost_centre (<=40 chars); rename note to details with explicit preservation of existing records; do not invent unknown predecessor data.
3. Permissions: grant temporary reviewer read-only access to department A until an explicit expiry; revoke immediately for new reads/tools/exports and preserve attribution. No duplicated policy in UI/MCP.
4. Integration: on frozen CanMail, replace MailV1 binding/provider mapping while preserving business operation, event identity, status, recipient locale and fixed content; compare stable owner contract edits vs mapping/setup obligation. This is separate from J1; no required outgoing provider is invented for a small app.
5. Focused context: locate/alter the same expense rule in a single-file and a package-distributed scratch layout, source meaning unchanged. Threshold >EUR500 needs distinct finance review after manager approval, EUR500 exempt. Do not drop source histories, private receipt restrictions, stale version behavior, self-review denial or reimbursement rules. Source placement cannot change semantics.

Record touched source/context, assumptions, correctness/omissions, repair feedback and unchanged required outcomes. B owns semantic review; C owns interfaces. Report token economy only after acceptance coverage is compared, and distinguish observed draft effect from later execution-dependent migration/provider/permission guarantees.
```

## design/evaluation/evidence/language/rules.md:1–27

```text
# E007 — Rule authority and interpretation handoff

Status: initial static reconciliation, 2026-10-04. Baseline prefix below is `design/evaluation/baseline-20261004T041647Z/snapshot/`. Live `EVALUATION.md` controls method and the draft-only boundary; frozen sources control evaluated semantics. Later evidence is identified separately.

The product is a proposed language and library contract. Desired MJS is handwritten. Missing compiler, standard library, infrastructure, semantic checker, or execution is **unverified implementation**, never a design failure. Real conflicting contracts and missing required app behavior remain assessable. Company replacement is evaluated across required composed workflows, with one deployment allowed; app count is not a saving.

| Rule / authority | Interpretation for experiments and target comparisons | Citation |
| --- | --- | --- |
| Document precedence (explicit present contract) | REQUIREMENTS owns goals, DESIGN semantics, GRAMMAR exact written form. DECISIONS history is not a parallel specification; do not enforce old MINE/OPEN proposals. User goals are reviewable with evidence but not silently overridden. | DESIGN.md:3; DECISIONS.md:5–9; live EVALUATION.md:100–104 |
| Canonical primitives (user requirement) | CRUD/auth/pages have one source authority; custom scenarios encode actual additional business work. A helper name does not install behavior. Quantify repeated mechanics before proposing syntax. | REQUIREMENTS.md:33–45; DESIGN.md:5 |
| Identity/composition (user outcome; chosen notation) | Implicit package identity is authored app name; `uses` selects product, `use` imports exported owner symbols. File moves preserve identity; app renames do not. Packages do not require separate deployments. | DESIGN.md:15–19,39–45,81–91; DECISIONS.md:13,30 |
| Defaults (user repetition goal; particular choices reviewable) | Workerd/D1/auth/teams/UI/MCP/theme/locale/file baseline is language-version pinned. Stored models default team, not permissions. Explicit app/parent scope is genuine deviation. Merge explicit composed contexts before applying defaults; imports do not import app context. | DESIGN.md:19,95–99; REQUIREMENTS.md:75–79 |
| Operation body / invariant spelling (explicit user changes) | Executable bindings remain inside `do`. Given constraints use `invariant`; execution/presentation/migration guards use `require`. Do not count old saved proposals as present source errors. | DECISIONS.md:21,715–717; GRAMMAR.md:261 |
| Description/localization (explicit user outcome; current notation) | `#` attaches metadata, `##` is ignored comment, inline keyed `@{locale=...}` is current. `label=` inherits schema labels. A single source-language override and viewer locale have different meanings. | REQUIREMENTS.md:49–67; DESIGN.md:11–13; DECISIONS.md:48 |
| UI vocabulary (user technology choice) | daisyUI via canonical primitives is current; PatternFly is superseded. C owns detailed current prop/interface comparisons. | DECISIONS.md:23; REQUIREMENTS.md:93–118 |
| Exact scalar / reused type contracts (chosen semantics) | Required non-null scalars omit `!`; nullable/default/server differ. Reuse carries value constraints, not initializer/authority. Omitted update differs from explicit null. | DESIGN.md:122–134; DECISIONS.md:25,28 |
| Version/order contract (chosen semantics) | Admitted existing row version stays v through transaction; accepted write reserves v+1 once, including no-op. Hook-after exposes v+1. Child-only write does not advance parent. CRUD admission sees normalized proposal but queries see prior provisional owner state. | DESIGN.md:101–103; DECISIONS.md:708–710 |
| BDD contract (user colocated-test goal; chosen table design) | Independently authored expectations invoke actual operation under its authority. Invalid fixture setup cannot count as expected rejection. Finalized files are provisioned actual test bytes; no fake file IDs. | REQUIREMENTS.md:39–47; DESIGN.md:349–411 |

## Conflicts / stale text to avoid propagating

1. DECISIONS.md:15 still says the migration retained implicit `main`; its later paragraph :30 explicitly supersedes that identity. Use DESIGN.md:39–45, not `main` in new artifacts.
2. DECISIONS.md:19 and :25 record intermediate decisions retaining scope/requiredness before later adoptions (:25/:28). Use current scalar and scope rules above.
3. DECISIONS.md:50 says “Tables are chosen” and describes locale-column layout after :48 records the user's inline-keyed replacement. This is stale historical prose within “Current status,” not a second current grammar. Smallest correction would label paragraph :50 as historical and link :48; no language change is needed. Benefit: fewer spurious experiment/target failures; tradeoff: documentation edit only; reevaluate by an agent resolving localization with both paragraphs present.
4. DECISIONS.md:34 explicitly says recurrence admission, availability expansion, daily reservation/pricing and federated refresh remained app work then. Later changes may close particular portions; these sentences are leads to inspect actual app bodies, not current failures by themselves.

No remaining conflict above warrants declaring an artifact invalid under two incompatible rule sets. Additional substantive ambiguity will be added here and messaged to A/C before affected conclusions close.
```

## design/evaluation/baseline-20261004T041647Z/snapshot/examples/TeamTasks.can:1–51

```text
# Manage team tasks, assign active teammates, and track completion. @{nl="Beheer teamtaken, wijs actieve teamleden toe en volg de voortgang."}
app TeamTasks
Given
 preferences { view:enum(all,unfinished,finished)=all label={text="Task view"@{nl="Taakweergave"},values={all="All tasks"@{nl="Alle taken"},unfinished="Unfinished tasks"@{nl="Open taken"},finished="Finished tasks"@{nl="Afgeronde taken"}}} }
 Todo { title:text trim max=200 label=field_title, done:bool=false label={text=done,values={true=done,false="Open"@{nl="Open"}}}, assignee:member? label="Assignee"@{nl="Toegewezen aan"} } label="Task"@{nl="Taak"}
 policy Todo read=members
 fixture task=Todo {title="Ship prototype"}
 export message add = "Add"@{nl="Toevoegen"}
 export message field_title = "Title"@{nl="Titel"}
 message done = "Done"@{nl="Klaar"}
 message task_count(n:int) = "{n, plural, one {# task} other {# tasks}}"@{nl="{n, plural, one {# taak} other {# taken}}"}
When
 crud Todo by=members fields=title,done,assignee label={create=add}
  examples update record=task
   as,changes.done,request.record.version -> record.done,format(task_count(count(Todo)),locale="nl")
   members,true,1 -> true,"1 taak"
   members,true,0 -> error(conflict)
   public,true,1 -> error(forbidden)
Then
 # Add work, assign teammates, and track what is finished. @{nl="Voeg werk toe, wijs teamleden toe en volg wat klaar is."}
 page / title="Team tasks"@{nl="Teamtaken"}
  card "Add team work"@{nl="Teamwerk toevoegen"}
   form Todo.create fields=title,assignee display=inline
  card "Tasks and completion"@{nl="Taken en voortgang"}
   text task_count(count(Todo))
   tabs preferences.view
   list Todo as task where preferences.view==all or (preferences.view==unfinished and not task.done) or (preferences.view==finished and task.done) order=-created search=title filter=done empty="No tasks yet. Add your first task."@{nl="Nog geen taken. Voeg je eerste taak toe."}
    edit
    delete
# Keep shared team notes. @{nl="Bewaar gedeelde teamnotities."}
app TeamNotes
use TeamTasks {add,field_title}
Given
 preferences { show_content:bool=true label="Expand note content"@{nl="Notitie-inhoud uitklappen"} }
 Note { title:text trim max=200 label=field_title, content:text? label="Content"@{nl="Inhoud"} } label="Note"@{nl="Notitie"}
 policy Note read=members
When
 crud Note by=members fields=title,content label={create=add}
Then
 # Write and browse the team's notes. @{nl="Schrijf en bekijk de notities van het team."}
 page /notes title="Team notes"@{nl="Teamnotities"}
  card "Write a note"@{nl="Een notitie schrijven"}
   form Note.create display=inline
  card "Shared notes"@{nl="Gedeelde notities"}
   list Note search=title display=split
    edit
    delete
    details "Note content"@{nl="Notitie-inhoud"} open=preferences.show_content
     text row.content
# Manage tasks and notes together. @{nl="Beheer taken en notities samen."}
app TeamOffice uses=[TeamTasks,TeamNotes]
```

## design/evaluation/baseline-20261004T041647Z/snapshot/REQUIREMENTS.md:1–120

```text
# canlang requirements

## Purpose and primary goal

canlang is an AI-native, Cucumber-style Given / When / Then DSL built specifically for SaaS and running on workerd.

Its primary goal is to maximize its chances of adoption. Every design and implementation decision must serve that goal. Token efficiency, reliable AI generation, and simplicity are means to achieve it.

## Target audience and product bet

canlang targets companies that want to replace expensive SaaS subscriptions with custom, AI-generated applications tailored to their own operations. Design decisions should make those applications economical to generate, run, and change as the company's needs evolve.

The product bet is that many company SaaS needs can be met by tailored applications built from records, permissions, business rules, workflows, and standard interfaces. Making those applications economical to generate and maintain is the focus of the language.

## SaaS-specific scope

canlang is a DSL specifically for CRUD-centered business SaaS applications. Start with canonical CRUD and the common SaaS behavior needed around it. Support company-specific data and business rules through those primitives without requiring a new implementation pattern for each application.

Applications whose core value requires a specialized foundation beyond this model are outside the supported scope. Examples include collaborative design tools, video editors, and large-scale observability engines. Ordinary business reporting and shared records remain within scope. Existing drafts of applications outside this scope do not expand the language's requirements.

Presentation serves that scope. Provide the bounded daisyUI component surface defined in [DESIGN.md](DESIGN.md#9-browser-presentation), with shared themes and layout options. Arbitrary HTML, CSS, JavaScript, and specialized visual editors are outside v1.

## AI-native and token-efficient

AI writes canlang; humans will never write it. Design the syntax for compact, unambiguous, reliable AI generation. Human readability is secondary.

Required repetition is a language-design failure: it wastes tokens and reduces adoption chances. Declare shared context once and reuse it. Preserve Given / When / Then semantics without unnecessary keyword repetition, repeated setup, or boilerplate.

Audit repeated syntax across real apps before preserving it as mandatory configuration. Uniform setup belongs in version-pinned defaults; declare only differences. Do not repeat a default attribute, an identical inherited field list, or an always-true optional condition. Keep actual business conditions, permission choices and independently authored test expectations; reduce their duplicated expression through canonical reuse rather than silently removing their meaning. [The repetition audit](DECISIONS.md#token-repetition-audit) records measured occurrences, applied reductions and further grammar candidates.

Scalar model, contract and event fields are required and non-null by default: `title:text`. Declare nullability with `?`, creation defaults with `=`, and protected initialization with `server=`. Arrays keep their default `[]`; `T[]!` explicitly requires array input. Do not repeat a required-scalar `!`. Pure nullable expressions use `?.` for field access and `??` for null fallback, with type checking, short-circuit evaluation and access rules defined in DESIGN. These operators never grant permissions or turn failures into missing data.

## One way per SaaS primitive

Provide exactly one canonical way to express each basic SaaS primitive, including CRUD, authentication, and page definitions. SaaS behavior must be directly expressible in the DSL.

Enforce this constraint in the language itself so AI cannot introduce competing patterns or unnecessary layers for the same behavior.

## Tests alongside business logic

Business behavior includes executable examples in the same `.can` source, attached to the operation they check. Reuse the operation's types and invocation instead of copying API signatures or writing separate step definitions. Declare shared test fixtures once; compact example tables vary only relevant state, inputs, actors, and expected outcomes.

Examples follow BDD semantics: fixtures supply the Given, the enclosing operation supplies the When, and independently authored expected results supply the Then. They invoke the actual operation and check its persisted state, returned result, or rejection. Expected values must not be inferred from the implementation being tested. App examples express meaningful business success and rejection/failure cases; judge coverage by behavior rather than test counts.

Examples execute in isolated test state through the same operation runtime and permission checks. They never seed production data, become MCP tools, or call live providers. Shared runtime guarantees have shared tests; apps need not repeat the authentication, CRUD, or transport test suite. The concrete `fixture` and `examples` notation is defined in [DESIGN.md](DESIGN.md#51-inline-behavior-examples).

Attachment examples need real finalized test files, not fabricated IDs, metadata-only literals or incomplete uploads. Reuse the existing fixture declaration to provision version-pinned valid sample bytes through the shared upload/finalization rules. The common sample and ownership are defaults; declare only differences. Preserve distinct file identities, effective upload limits, attachment permissions and isolated storage per example row. Invalid fixture setup cannot count as an expected business rejection. File fixtures never enter production or MCP; app examples check attachment workflows while shared runtime tests cover upload machinery.

## Built-in internationalization

Internationalization is a language primitive. Keep single-use wording at its declaration or presentation site: `# Track work. @{nl="Volg werk."}` and `title="Tasks"@{nl="Taken",de="Aufgaben"}`. Language keys identify explicit variants; adding a language does not require aligned column edits or separate locale files. An owning app/package's source language defaults to `"en"`; its header may declare `source="nl"` when the authored source differs. This is separate from the deployment's default/viewer locale. Use Given `[export] message name[(typed_parameters)] = "Source"@{...}` only for actual reuse, preserving the existing grouped `use` mechanism. A message-only import brings pure localization assets, not the provider's business runtime or privileges. No extraction manifest, translation framework or lookup wrapper is required.

Use one canonical, bounded ICU MessageFormat profile for placeholders, plural/ordinal/select branches and localized scalar display. Translate whole messages rather than concatenating shared words into sentences. The compiler validates signatures, patterns, supported options and fallback cases; a parsed JSON string is not a validated translation. Ordinary business text, IDs, enum wire values, tool names, currencies and timestamps retain their meaning and are never translated automatically.

Generate standard authentication, team, CRUD, validation and navigation wording from language-version-pinned catalogs. Pin a finite reviewed identifier-and-type label vocabulary once; never infer arbitrary translations from identifiers. Put other business captions on their declarations through one `label=` attribute. A scalar supplies a caption; a field/parameter may use `{text=caption,values={case=caption,...}}`, and CRUD uses `{create=caption,update=caption,delete=caption}` for enabled actions. Omit unchanged defaults, preserve inherited field-type/model captions, and share equal complete labels through a named message rather than repeating translations. Explicit labels override defaults. Readable `#` prose may carry one final inline suffix translating the complete description; `#= message_path` is reserved for an actually reused static description, and `##` remains ignored. No duplicate UI or MCP documentation is required.

Choose the viewer locale through the shared interface, with deterministic whole-message fallback and the selected variant's plural/format rules. Explicit outbound rendering fixes recipient locale and content before durable delivery/retry. Preserve output escaping, directionality, accessible state and existing disclosure permissions. Locale and rendered messages must not decide business authorization or machine state. [DESIGN §9.1](DESIGN.md#91-built-in-internationalization) specifies ownership, reuse, locale selection, formatting and limits. The initial parser recognizes the new notation; pattern/type validation and runtime localization remain implementation work.

## Descriptions and code comments

In `.can` source, a line beginning with `#` is the description of the declaration immediately below it. It is first-class description metadata, not an ordinary code comment. Consecutive description lines form one description. One suffix on the final prose line supplies translations of that whole description, such as `# Track work. @{nl="Volg werk."}`. Bare prose stays static literal text in its logical owner's source language; it has no automatic interpolation. Use this same syntax for app, package, model, operation, and page descriptions; do not use a `description=` attribute for declaration metadata. A business-data field named `description` remains an ordinary field.

Reuse descriptions in their applicable interfaces: an app description supplies shared MCP context, an operation description supplies its MCP tool description, and a page description supplies the visible supporting text below its title. Standard CRUD descriptions can be generated without requiring repeated source descriptions. Descriptions keep the source understandable to humans while preserving compact AI-generated declarations.

Every app must have a concise `#` description immediately above its `app` declaration, explaining its purpose and the business work it supports. This is the app's canonical description. Reuse it as shared MCP server context through initialization `instructions`, without repeating it in every tool description. Operation documentation describes the individual operation within that context.

A line beginning with `##` is an ordinary code comment. It is not a description and is not included in MCP descriptions or page supporting text. `#= message_path` references one static zero-parameter message with the same attachment rules; it cannot mix with prose or another description reference. These forms are non-executable; descriptions never define or override permissions, validation, or business behavior.

## Packages and files

An app can consist of multiple packages. Each package uses one Given / When / Then structure for its declarations, workflows, and presentation. Packages are logical units, not file boundaries: multiple packages can live in the same `.can` file. Splitting them into separate files is optional and must not change their meaning.

Declare app identity, its description and composition in the actual business `.can` source. A project can contain several apps; select one app per deployment. Named packages and composed apps are selected through `app Name uses=[...]`, independently of file placement. The compiler derives its declaration index and dependency closure from source; no separate app-wrapper directory, authored build manifest or repeated source list is required. Discovery alone does not execute neighboring apps.

Share runtime, authentication, team context, and Cloudflare resource bindings across the selected app. The language version pins the standard workerd/D1, email/password auth, teams, daisyUI/HTMX/MCP, theme and file defaults; apps must not restate them. Included runtime declarations using `file` imply R2 and the default upload policy: PDF, PNG, JPEG and plain text, at most 10MiB per file. This baseline is defined once in the language; it does not grant upload/download access. Only different type/size limits, explicit queue/analytics/other resource bindings and genuine theme differences belong in `context`. Empty context blocks are unnecessary. Compatible explicit settings in composed apps merge; incompatible settings are errors rather than silent overrides. Each model and its canonical CRUD have one owning package; other packages reference existing models and operations without copying their declarations. Export interfaces on their owning declarations and import dependencies in the consuming package; no separate connections file or repeated export-name list is required. Deployed-service imports identify their deployment binding explicitly. Package boundaries do not create separate deployments, databases, services, or authorization systems. The composed app supplies one UI and MCP interface.

A small app is one implicit package identified by its authored app name and needs no package wrapper or standard setup lines. Small apps compose through the existing `app Office uses=[Tasks,Notes]` form without rewriting their bodies. Multiple implicit apps can share a file. Their model, role and operation names stay stable across file moves and standalone/composed selection; no generated `main` or composition alias is required. Imports use the existing grouped form against exported owner declarations, for example `use Tasks {Todo}`. An app assembled with `uses` does not create an aggregate package namespace. Composition deduplicates owners, keeps permissions and storage authority intact, and still reports actual route/resource conflicts. App renames change implicit declaration identity and require explicit migration rather than inferred aliases or data transfer. Larger apps select named `package` blocks and use explicit `use` references, as defined in [DESIGN.md](DESIGN.md#1-source-and-composition). File placement does not determine ownership or visibility. Importing a local dependency retains its authoritative behavior internally, without automatically mounting its whole browser/MCP product. Bound service imports contribute schemas and explicit integration bindings, never provider execution. The application drafts declare focused and composed apps in their business sources; [migration coverage](draft/MIGRATION.md) records unresolved requirements and validation limits.

Stored model declarations default to team ownership: `Task {title:text}`. Declare only different ownership, using `Line in Invoice {...}` for containment or `Setting in app {...}` for app scope. `role reviewer` declares the existing owner-assigned team role without a scope qualifier. These are canonical forms; repeated `in team` and role `in=team` are invalid. The default is pinned by the language version, independent of file layout, imports and composition. Structural types and value expressions do not acquire ownership. Team scope supplies no permissions or role assignments; policies, operation authority and existing team-resolution checks remain separate. Parent inheritance and explicit storage bindings retain their meanings.

Group explicitly named imports by provider and deployment binding: `use employee {can_work,staff,test_worker}`. Enumerate symbols and retain aliases; use the same form for a single symbol. A group's `from=deployment...` applies to every member, so different bindings and local imports remain separate. Grouping changes no visibility, ownership, privileges or service behavior.

Default small AI-generated apps to one file. As an app grows, organize it into files containing coherent packages, keeping each package's related models, permissions, workflows, and pages together. Use folders only when they help navigation. Do not split every model, workflow, or page into its own file or impose arbitrary file-size or package-count thresholds. Cross-package references must be explicit and discoverable so an agent can locate related declarations without reading the entire app.

## Runtime, services, and presentation

- Use workerd as the runtime.
- Make many Cloudflare-provided services first-class language features, directly expressible in the DSL.
- Make daisyUI HTML/CSS components first-class through the compact, bounded presentation primitives and theme options defined in DESIGN.md.
- Prefer HTMX for page interactions.
- Make MCP servers first-class: each app provides a generated MCP interface to its authorized business operations.

## Prefab HTML components

daisyUI is the built-in presentation foundation. AI selects and configures its components through first-class canlang primitives; shared markup, styling, and interaction behavior belong in the implementation. No app-level library selection, component imports, repeated namespaces, CSS classes, or per-page `htmx` marker are required. HTMX remains the default interaction mechanism.

Use [daisyUI components](https://daisyui.com/components/) for generated HTML markup and styling. The shared presentation build provides [daisyUI and Tailwind CSS](https://daisyui.com/docs/install/); apps do not declare these dependencies. canlang supplies data binding and behavior. The canonical mapping is:

| canlang declaration | daisyUI presentation |
| --- | --- |
| `page` | Shared Drawer/Menu sidebar shell and semantic page/section layout |
| `card` | Card title and body |
| `title` | Semantic heading using shared typography |
| page-derived navigation | Menu links using the owning page titles and access |
| `form` | HTML form with Fieldset, Label and type-appropriate Input, Textarea, Select, Checkbox, Radio and File Input controls |
| `list` | List |
| `table` | Table |
| `edit` | Inline edit with the same type-appropriate controls |
| `action` / `actions`, `delete` | Button controls, grouped with Join where appropriate, bound to existing operations; deletion applies the model's archive/remove mode |
| `text`, `content` | Semantic content with escaped, formatted values |
| `copy` | Button with runtime clipboard behavior |
| `history` | Runtime-labeled authorized audit Collapse, controlled by shared Appearance |
| `details` | Collapse; `display=drawer` opens one activated record detail |
| `tabs` / `tab` | Accessible Tabs and associated panels |
| `preferences` | Generated personal settings Fieldsets in the shared Modal |
| collection `empty` attribute | Shared empty-state composition using semantic text and existing controls |

Search uses Input; filters use Select and other type-appropriate controls; pagination uses grouped navigation Buttons. These are generated from the collection's existing attributes. Form controls, labels, required markers, and validation derive from model or scenario declarations. A form without `fields` uses the operation's declared inputs; `edit` without a field list uses the enclosing model's CRUD update fields in declaration order. Explicit field lists select a subset or different display order; they cannot expand writable permissions. Canonical forms keep submit controls and validation feedback implicit. Loading and operation feedback use Skeleton, Loading and Alert components. Declaring an action binds it to the same operation used by MCP; it does not redeclare that operation's inputs or rules.

CSV intake reuses the canonical form with `import=csv` and an optional owning pure `review` operation. Schema-derived previews retain invalid and duplicate rows for explicit correction or exclusion; confirmed rows invoke the same guarded operation once each with independent, replay-safe outcomes. Apps do not copy CSV parsing, input schemas, CRUD or standard localized panel controls. DESIGN §9 pins exact parsing, reference, review and partial-failure semantics.
```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:15–45

```text
A compilation selects exactly one app for deployment; the project may contain many app declarations. Supply the project root and an entry `.can` source. If that source declares more than one app, select the app by name. The compiler indexes `.can` app/package declarations within that root and follows composition and imports to determine inclusion. There is no authored build manifest or source registry, no ancestor-directory search, and no automatic execution of neighboring files. Discovery alone never deploys a declaration. Files have no namespaces, initialization order, or runtime effects.

App identity and its required `#` description belong in the actual business source. `app Name uses=[member,...]` selects named packages or other declared apps for the product. Apps and explicitly named packages share a project-wide namespace; duplicate or ambiguous authored identities are errors. A small app without `uses` also owns an implicit package identified by that same app name: one indexed declaration supplies both app selection and package ownership, rather than introducing a second conflicting declaration. Composition recursively expands app members, rejects app-composition cycles, and includes each canonical package once, including implicit bodies reached through multiple selections or imports. A package can be selected from any file without changing its identity or ownership. `uses` selects product membership; package-level `use` imports an exported symbol and grants no privileges. There is no membership inferred from file proximity or matching app/package names.

Every selected app starts with language-version-pinned defaults: workerd, D1, `auth email password`, teams, daisyUI/HTMX, the generated MCP interface, `theme mode=system accent=blue density=comfortable`, locale default `"en"`, and the file policy in §8. Do not repeat those declarations. Permissions, roles and business rules remain explicit. Optional `context` immediately follows the app it configures and contains actual theme/file-policy/locale differences or named Cloudflare resource declarations. Omit an empty context. Auth/runtime/storage words retain their canonical meanings but spelling their unchanged defaults is unnecessary; unsupported alternatives are errors, not new authentication patterns. Explicit contexts of composed apps merge by resource name/setting: identical explicit values coalesce, incompatible explicit values produce a diagnostic instead of silently overriding or provisioning another deployment. Apply language defaults after merging explicit values, so an omitted value is not a conflicting assertion. Imports of dependency packages do not import another app's context. Every included package's resource references resolve through these defaults or the selected app's merged explicit context.

Small-app form:

```can
# Track the team's work.
app Tasks
Given
 export Todo { title:text trim, done:bool=false }
 policy Todo read=members
When
 crud Todo by=members fields=title,done
Then
 page / title="Tasks"
  form Todo.create display=inline
  list Todo
   edit
   delete
```

This is the app's implicit package `Tasks`, selected by omitting `uses` and supplying its Given/When/Then directly. Its models and operations have identities such as `Tasks.Todo` and `Tasks.Todo.create`, unchanged when Tasks is selected alone or included by another app. There is no generated `main` segment, assembly prefix or alternate alias for that owner. Existing explicit package identities retain their meanings.

Each implicit app has its optional context immediately after its app declaration, then any package imports before one complete ordered Given/When/Then body. That body ends at the next top-level `app`, `package` or `migration` declaration, or end of source. Multiple implicit apps and independent named packages may occupy the same file; file placement adds no membership. An app with `uses` cannot also supply an implicit body. It may have grouped message-only imports after its optional context for localized app metadata; those imports create no business package. A bare app without a complete body is an error, not a request to infer neighboring packages. A migration cannot interrupt incomplete Given/When/Then sections.

For two small apps Tasks and Notes, `app Office uses=[Tasks,Notes]` selects the distinct canonical packages Tasks and Notes without rewriting either body. Nested composition and import paths deduplicate each owning package; they never create another instance of its models, roles, handlers or work. Selection still merges the included apps' explicit contexts, while a symbol import retains the dependency/exposure rules below. Composition does not alter declared page routes or resource names: duplicate normalized routes and incompatible explicit contexts remain errors. [The task reference source](examples/TeamTasks.can) demonstrates two implicit apps and their composition in one file.

File moves and a different selected composition do not rename an implicit package. Renaming its authored app identifier does rename its model, role, operation and other declaration identities, including generated tool names; this requires explicit identity migration for deployed state/interfaces. Extracting its body into a differently named explicit package likewise changes identity. An explicit package cannot reuse the unchanged app's name under the existing shared namespace. No automatic rename, data transfer or compatibility alias is inferred. Separate deployments still have separate runtime state and authority. Explicit-package form names its members on the app declaration:
```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:95–135

```text
`Model {fields}` declares a stored team-scoped model in Given. Team ownership is the language-version-pinned default, including exported models; it is not inferred from a filename, package, import, composition, neighboring declaration, or model-reference field. `Model in Parent {fields}` explicitly creates a child with an implicit required, immutable `parent:Parent`; it inherits the parent's team and storage owner. `Model in app {fields}` explicitly declares app-scoped data and requires policies. A child is accessed as `parentRecord.Child`; that is a typed collection, not a copied relation. Other relationships are explicit model-typed fields. Changing containment or team is not an ordinary update.

Omitted ownership always means team, never parent containment or app scope. The selected app retains its existing team-resolution and admission rules: a default does not create or select a team, supply a missing team context, or grant membership. Public record access still resolves team from the record, and trusted handlers still obtain it from their verified occurrence. Storage placement remains separate: `Model at=Binding {fields}` is team-scoped at that binding, while explicit children retain inherited placement. No package or context setting changes the ownership default.

This shorthand applies only to stored declarations in Given. `contract`, `event`, capability value schemas, fixtures and constructor/struct expressions retain their existing meanings and do not acquire ownership. A model-reference field does not introduce a protected parent binding. Scope grants no reads or writes: absent read policies deny, operation authority remains explicit, and field grants, uniqueness scope, references, invariants, locks and versions still apply. The redundant `Model in team` spelling is invalid; its diagnostic directs the author to omit `in team`. The explicit parent/app forms are actual ownership choices, not alternate spellings of the default.

Every record has `id`, `version`, `created`, `updated`, `created_by`, `updated_by`, and nullable `archived_at`. These names are reserved. IDs are opaque strings; attribution names stable accounts or trusted sources and survives membership removal. A model name denotes a type/collection, **never a current record**.

A created row has version 1 throughout its creating transaction, including create-hook adjustments. Ordinary references to an existing row expose its admitted version `v` throughout the owner transaction while field reads observe ordered provisional changes. An accepted `set`, CRUD update or archive reserves `v+1`, even for a normalized same-value write. Further writes/calls/hooks to that row do not advance it again. Update-hook `event.before.version` is `v` and `event.after.version` is the reserved `v+1`; create-after is 1. Permanent removal has no after record; its deleted event carries `v+1`. A child write does not advance an unwritten parent. Failed operations advance nothing; receipt replay reapplies nothing. This write-intent rule intentionally produces history/version changes for accepted no-op writes. Locks compare stored values, not modification metadata.

| Type | Value and boundary |
| --- | --- |
| `text`, `bool`, `int`, `decimal` | Unicode string, boolean, signed 64-bit integer, exact decimal with at most 38 significant digits and 18 fractional digits; overflow is an error |
| `enum(a,b,...)` | Closed set of identifier values, serialized as strings |
| `email`, `url` | Validated strings; URLs limited to HTTP(S); email verification belongs to auth |
| `locale` | Validated canonical BCP 47 language tag for presentation/recipient preferences; no authority or timezone inference |
| `date`, `datetime`, `duration`, `timezone` | Calendar date; millisecond-precision UTC instant; integer milliseconds; IANA zone identifier |
| `currency`, `money` | ISO currency code; `{minor:int,currency:currency}` with pinned currency minor-unit scales |
| `user`, `member` | Stable account reference; team-scoped membership reference with retained attribution |
| `Model`, `Model.field` | Record reference; reuse a field's value type and validation constraints |
| `Contract` | Named structural value, stored by value, not a live model reference |
| `action(Operation,...)` | Finite reference to declared user operations, carrying protected record bindings; not executable code or a permission grant |
| `file`, `secret`, `json` | Completed immutable R2 reference; server-only opaque secret; opaque bounded JSON |
| `T[]`, `T?`, `A\|B` | Homogeneous ordered array, nullable value, tagged union of named types |

`contract Address {street:text,city:text}` defines a structural type. Contract fields follow model field rules but have no ownership or metadata. JSON has no arbitrary property access. `if value is Contract` validates a JSON value against that closed contract (including bounds, defaults, and rejection of unknown fields), and narrows it within the true branch; failure takes the false branch. A union's wire value is `{type:"QualifiedType",value:...}`; common compatible fields are readable, and `if value is Type` narrows a branch. A model reference is not an embedded copy of its record.

Stored field forms are deliberately distinct:

- `name:T` requires a non-null create value.
- `name:T?` defaults to null; explicit null is legal.
- `name:T=expr` supplies a non-null default on creation only.
- `name:T[]` defaults to `[]`; `T[]!` requires an array input.
- `name:T server=expr` supplies the server value on creation and excludes it from client inputs. `secret` fields always require server initialization.

A bare scalar without a default/server expression is required and non-null, matching operation parameters. Scalar `!` is not supported; `[]!` remains the explicit required-array-input form. A missing required value is an error, never an inferred business value. Nullable, defaulted and server-owned fields retain their existing creation behavior; partial updates still distinguish an omitted change from explicit null. A default's context requirements are checked at every creation path: for example, `submitted_by:user server=actor` requires an authenticated creator; a trusted handler cannot supply a null actor to that field. Field modifiers are `trim`, `min=`, `max=`, and `unique`; text/array min/max measure length, numeric min/max measure value, and bounds are inclusive. Constraints run after normalization. Explicit `invariant` handles strict inequalities and relationships. `unique Model fields=a,b [where=expr]` declares a composite uniqueness constraint within its containing parent, team, or app. Null values do not participate unless the predicate explicitly includes them. Retained archived rows participate.

`derive Model.field:T = expr` defines a read-only computed field in scope `row:Model`. `derive name(p:T,...):R = expr` defines a pure function. Parameters and result types are explicit; obvious local values and generated CRUD schemas are inferred. Field type references remove repeated enum/bound definitions. Derived definitions cannot recurse, perform effects, or depend on incidental UI state.

A type path can resolve to a named type or a declared model/contract/event/computed field's value type. Field reuse carries representation, nullability, normalization and value bounds. It does not copy creation defaults, server initialization, required-array input metadata, uniqueness, ownership or permissions. Modifiers on the receiving declaration still require compatibility checking. The bounded grammar permits a named union, one array suffix and then one nullable-container suffix: `A|B[]?` is a nullable array of union values. Nullable elements, nested arrays and grouped types are outside v1. Apply suffixes to the resolved reused type: an additional array suffix on an array/nullable type and a redundant nullable suffix are errors. A reused nonnullable array can accept field-only `!`; resolving whether a qualified path denotes such an array requires the checker.

```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:150–178

```text
## 3. Expressions, queries, and scopes

An expression is a literal, lexical name, field access, list/struct value, typed function call, query, or operator expression. Struct literals use `{field=expr}`; `{field}` means `{field=field}`. A contract value is `Address {street,city}`. Operators from lowest to highest precedence: `??` (right-associative), `or`, `and`, prefix `not`, comparisons (`== != < <= > >= in is`), `+ -`, `* / %`, unary `-`, member access/call (including `?.` for member reads). Boolean operators short-circuit. Mixing `??` with `and` or `or` in the same unparenthesized expression is an error; group the intended boolean or fallback subexpression explicitly. Chained comparisons are forbidden. Calls accept positional arguments followed by unique named arguments, with no later positional argument. No implicit truthiness, string/number coercion, assignment expression, or arbitrary JavaScript.

Null equals null; other ordered/arithmetic operations on null are type errors unless narrowed by a preceding check. `value ?? fallback` is the sole null-fallback form; the earlier `coalesce` builtin is removed. Enum literals require a uniquely expected enum type. A string literal can inhabit an expected validated string-like type, such as currency, email, or URL, after validation; this does not coerce an arbitrary text variable. Unresolved bare identifiers are errors. Indexing arrays uses zero-based integers and `at(array,index)` returns a nullable item; no unchecked `[]` indexing. Currency values never coerce to decimal.

`receiver?.field` is pure, read-only member access on a nullable receiver. It evaluates the receiver once: null yields null, otherwise it performs the ordinary typed field access. The result is the selected field's type made nullable, with no nested optional wrapper. Each nullable hop requires `?.`; ordinary `.` still requires a non-null receiver. A statically non-null receiver uses ordinary `.`. Optional calls, indexing and mutation targets are not introduced. Invalid field/type access and authorization or business failures remain errors rather than becoming null. The operator supplies no directory access or additional privilege.

For `left ?? right`, `left` must be nullable with underlying type `T`; `right` must have compatible type `T` or `T?`, without coercion. Evaluate the left once, and evaluate the right only when the left is null. False, zero, an empty string and an empty array are values, not reasons to choose the fallback. A non-null right makes the result non-null; a nullable right leaves it nullable. Both operands must type-check and retain the existing dependency/return-disclosure rules, even when one is not evaluated. Arithmetic binds more tightly, so `(row.until ?? now)-row.from` requires grouping around the fallback. In a function argument, `overlaps(from,until,entry.from,entry.until ?? now)` uses the argument boundary to delimit it.

A true equality between a safe-access result and a statically proven non-null value narrows every traversed nullable receiver and the selected value to non-null in that continuation, including following `and` operands. For example, `event.result?.source==revision.id` proves `event.result` non-null when true because record IDs are non-null. Equality to null, comparison to a nullable value and `!=` do not supply this true-branch narrowing fact; keep the necessary explicit checks. This is a typing fact, not an inferred business permission or a rule that moves guards ahead of effects.

Lexical names are parameters, `let` values, query aliases, imported declarations, and fixed context: `actor:user?` (stable `user.id:text` is readable; no account-directory fields), `team:Team` when applicable, `now:datetime`, and `operation:OperationContext` with read-only `id:text` and `source:text` fields. Team exposes `id` and `timezone`; a membership exposes `id`, `user:user`, and `team:Team`. Authenticated/member/role authorization narrows actor to non-null. Trusted handlers have `actor=null`; attribution uses their verified source, and team is derived from the verified occurrence, never an arbitrary payload grant. `now` is fixed at admission across internal retries; generated IDs and random values are also stable across retries. `row` is bound only inside a model policy/invariant/derive/lock or a collection child; scenario bodies use their named record parameters. Bare field selectors in UI attributes such as `columns=title,done` are schema selectors, not general expressions. There is no fallback search through unrelated records for a matching field.

Queries have one form, starting from an ordinary expression yielding a model, parent-child collection, array, or typed collection-valued local:

```can
Model as item where predicate order=-item.created select expression
invoice.Line as line select line.quantity*line.price
```

`where`, `order`, and `select` are optional and ordered as shown. An omitted select yields records. Aliases are required when an expression accesses an element. Query values can feed `count`, `sum`, `min`, `max`, `any`, `all`, `first`, or a presentation collection. `any(domain as x,predicate)` and `all(domain as x,predicate)` separate the domain from the predicate. `all` of an empty domain is true; `any` is false. Require `count(domain)>0` separately where necessary. `first` returns nullable and requires stable ordering. `min`/`max` of an empty domain are null; numeric sum is zero; money sum requires an explicit currency when the domain may be empty: `sum(query,currency)`.

The query tail binds after ordinary operators and follows `archived=include`, `as`, `where`, `order=`, `select` in that order, each at most once. Clause values end at the next clause or enclosing argument/header boundary; parenthesize a query used within larger arithmetic. Query `order=` takes one expression. UI field selectors and fixed ordering take selector lists; preference ordering uses the closed §9 default/exception map, so their commas cannot consume an aggregate's second argument or an example cell. The first domain alias in `any`, `all` and `group` is visible in their second expression; ordinary calls do not create that scope. Loop bindings and query aliases are distinct. [GRAMMAR.md](GRAMMAR.md#expressions-and-values) specifies exact boundaries.

Default record queries exclude archived and expired rows. `Model archived=include` includes archived rows but never expired content (§7.1). Record ordering defaults to `created,id`; ID is appended as a final tie-breaker. `group(query as item,keyExpr)` binds that alias in its key expression and produces typed `{key,items}` groups, usable in queries and reports. For example, `group(selected as expense,expense.status)`. It never invents fields or a callable function from a group name.

The following is the complete operator matrix. “Compatible” means the same representation/type, with only the explicit int/decimal and validated-text comparison exceptions below. No overload is inferred from a function or field name. Unlisted operand pairs are type errors.

```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:270–393

```text
Duplicate authored bindings in one scope are errors. An ordinary nested suite or query may shadow an outer authored binding. A new local binding is introduced after resolving its initializer; a query alias is introduced after its domain and has precisely the scope described in GRAMMAR. Authored bindings cannot hide an active injected `actor`, `team`, `now`, `operation`, or the context-specific `row`, `event`, `preferences`, `result` or `before`. These are contextual facts, not globally reserved spellings. A language-created nested collection context may introduce its own `row` as already specified, retaining the enclosing record chain. A query or parameter called `row`/`event`/`before`/`result` remains legal where that contextual binding is absent. Closed builtin names cannot be replaced by package declarations; ordinary authored locals may hide callable or actor-predicate names, in which case an incompatible later use is an error.

Signature defaults are pure and checked/evaluated from left to right. Each default may use earlier resolved parameters, imported pure declarations and the fixed facts available at that signature's pre-authorization types; it may not use itself, a later parameter or a body binding. A supplied argument takes the place of its default. Authorization does not retrospectively make `actor:user?` nonnullable inside a default. Existing dependency/read-disclosure checks still apply to queries and calls; this rule grants no pre-authorization record access. Field creation defaults/server initializers retain §2's creation-context checks and do not acquire a new implicit sibling-field scope from this signature rule.

## 4. Permissions and rules

The default `auth email password` primitive provides verified-email registration, sign-in/out, expiring email-token recovery, sessions, and MCP authorization. Default `teams` support adds owner-managed membership, expiring verified-email invitations, roles, team selection, and a team timezone (UTC until configured). Neither needs a source setup line. Deployment provisions the first owner. `role billing` declares an owner-assigned team role; `owner` and `members` are built in. Roles retain package-qualified identities and export/import visibility: equal names in different packages do not merge. Declaring a role neither assigns it nor grants data access. V1 roles support only team scope; `in=team` is redundant invalid syntax, with a diagnostic to omit it, and other role scopes remain unsupported. App authors do not implement alternative login or role tables.

`members`, `owner`, a declared role, `authenticated`, and `public` are actor predicates. They can combine with boolean record predicates. At team scope they test the resolved team. `actor` is null for unauthenticated public requests. Membership management rejects removal/demotion of the last owner; invitation acceptance verifies the addressed email and cannot grant a role beyond the stored invitation. A completed membership removal prevents new admissions; an already admitted operation may finish. On D1 the fenced commit also detects intervening membership changes. Historic membership references remain readable where record policies permit; new member assignments must be active.

A declared role also accepts one explicit subject: `salesperson(person)` returns bool for `person:user` in the current verified team. This is a role predicate application using ordinary call syntax, not a first-class callable/value type. Resolve the callee by normal lexical/import rules; its declaration must be a visible declared team role. The existing bare `salesperson` is the canonical literal-actor spelling; `salesperson(actor)` is redundant and diagnosed, while another expression may evaluate to the same account. Built-in `owner`, `members`, `authenticated` and `public` do not gain a call form; `active_member(person,team)` remains the existing explicit membership test. No-team contexts cannot evaluate a declared team role.

The subject must be an active member of that team with the explicit package-qualified assignment; a team owner does not automatically hold every declared role. Missing, inactive or foreign-team membership yields false. Use current admission authorization state and the same commit fence as caller-role checks. The predicate provides neither account enumeration nor record access, never switches actor, and never narrows actor to nonnull merely because another subject holds a role. It can restrict prospective assignments but must not be a stored historical invariant that invalidates old records on later revocation. No role-name strings, dynamic role values or second role storage are introduced.

For the authenticated caller only, `actor.email:email` and `actor.email_verified:bool` are read-only admission facts supplied by canonical auth. They permit explicit addressed-invitation acceptance without a parallel identity service. Other user references do not expose those properties or a global email directory; request inputs cannot override them.

```can
policy Candidate read=recruiter
policy Candidate read=interviewer where=row.interviewer!=null and row.interviewer.user==actor fields=name,interview_at
invariant Line: row.quantity>0
lock Invoice fields=customer,total when=row.status!=draft
```

Policies grant **reads**, including files. No policy means deny. Matching grants union their fields for matching rows; omitted `fields` grants ordinary fields and safe record metadata, never secrets. Identity/team/parent boundaries always apply. Public and external-user grants are explicit exceptions to membership requirements, evaluated in the resolved record/team scope. New cross-team record relationships are rejected.

User queries apply row/field permissions before filters, searches, ordering, counts, aggregates, relationship expansion, and serialization. A derived value is readable only if its data dependencies are readable. A confidential aggregate needs a specifically authorized read scenario with `scope=authority`, described below. No separate `projection` primitive duplicates policy field grants.

Pure queries inherit their declaration's evaluation authority. Read-policy decisions, invariants, pre-state locks, CRUD `when` and mutation/trusted-handler decision expressions inspect bounded authority state at the resolved storage owner; they do not recursively apply read policies to their decision scans. Derives inherit the caller's mode. Team/parent/storage boundaries, expiry and work bounds still apply. A policy may inspect its own grant-table model without recursively evaluating that model's read policy. Pure derive/call cycles are invalid. Ordinary viewer queries and `read=true` bodies remain permission-filtered; authority decision data does not become a result grant. The existing explicit `scope=authority` report boundary remains required for confidential outputs.

`invariant Model: predicate` is a pure invariant in `row` scope, checked for every affected row in the proposed final state. Dependency analysis rechecks relevant rows when referenced data changes; oversized dependency work fails with a bounded-work error. Deleting a referenced row fails unless references have been removed in the same operation. Invariants do not emit events or perform effects. `invariant` is the sole Given introducer; the former Given `require Model: predicate` spelling is invalid. Execution guards, presentation gates and migration/backfill checks retain `require`. Both words remain contextual names outside their syntax slots.

`lock Model fields=... [when=predicate]` evaluates on the **pre-state**. An omitted predicate means true: the fields are always locked, so do not repeat `when=true`. If the predicate is true, those field values cannot change and the row cannot be removed, including through scenarios or hooks. The sole lifetime exception is whole-record disposal after declared expiry (§7.1), not early deletion or field editing. The transition establishing a conditional lock may set final values. A child rule may inspect `row.parent`. Archival preserves locked values. No separate freeze/immutable/snapshot variants: copy selected values into typed snapshot fields with `set`/`create`, then lock them. Audit history is automatic.

Operation `by` governs its writes independently of generic CRUD input fields. All paths still enforce ownership, invariants, locks, versions, and reference validity. Scenarios may inspect authority data needed for their rules; this does not grant callers access to that data. Guard failures default to a generic business-rule error; diagnostic messages must not disclose confidential values, including arguments omitted by the selected translation.

## 5. Canonical operations

```can
crud Todo by=members fields=title,done,assignee
# Complete an open task.
scenario complete(todo:Todo) by=members
 require not todo.done
 do set todo {done=true}
```

There is at most one `crud` declaration per model. It generates create, update, and delete operations. `fields` is the update allowlist and, unless a different `create_fields` is supplied, the create allowlist. Do not copy an identical list into `create_fields`. `create=none`, `update=none`, or `delete=none` disables that operation. `when=predicate` applies to each normalized proposed create/update row and the existing delete row. Prepare defaults and server-owned fields without staging this write, evaluate the predicate, then stage only on acceptance. Field reads through `row` observe the candidate; model scans observe the provisional owner store immediately before this write, including earlier effects but not this candidate write. Updates still leave the old stored row visible to scans during admission. Delete admission runs before removal. Final invariants inspect the completed provisional state. Mandatory cross-path business rules belong in invariants/locks. All required create fields must be supplied, defaulted, or server-owned. A child create takes its protected parent binding. Create defaults do not run again on update; omitted update fields are unchanged, and explicit null clears a nullable field.

Omitted deletion mode means archive: delete archives the row and its contained subtree, atomically. Do not repeat `delete=archive`. It does not create a second archive API. `delete=remove` permanently removes an unreferenced row/subtree and is explicit; `delete=none` preserves an intentional prohibition. Existing references to archived rows remain valid for authorized history; new references cannot target them. Archived rows cannot be edited; restoration is outside v1. Audit/receipt retention is independent of deletion.

A scenario declares every parameter's type. `p:T` is required; `p:T?` defaults to null; `p:T=expr` has a default. `Model.field` inherits value constraints, not its storage default/server ownership. There is no inference from parameter spelling or later prose. Parameter defaults are pure and evaluated at invocation. A mutation's record parameters carry expected versions; read parameters need only IDs.

External mutation admission authenticates the caller/resolves the authorized team and checks `by` before the body. Record inputs resolve their declared type, owner/team, lifetime and expected version within that boundary. The operation’s authored guards govern permission to mutate that record; an ordinary viewer read grant is not an extra universal write prerequisite. This retains §4’s separate read/write permissions rather than silently granting reads to make a write possible. An unreadable record supplied by opaque ID confers no authority: the same owning guards still run and may reject with the generic `rule_failed` without exposing confidential values. Missing, expired or foreign-owner references remain `not_found`; ordinary read/look-up interfaces hide unreadable rows, and page pickers remain viewer-filtered. Return values and changed-record projections still obey their existing disclosure rules, and file attachment authority is checked independently. A caller with only broad operation membership cannot bypass a missing per-record business guard; such a missing guard is an application defect, not inferred permission from an ID. Trusted handlers retain their verified source authority and local calls retain their unchanged caller.

The effect vocabulary is finite:

| Statement | Meaning |
| --- | --- |
| `let name=expr` | Immutable local binding |
| `require expr [message=expr]` | Reject without committing if false; message is literal text or a message descriptor |
| `create Model {fields} as name` | Insert and bind a record; child inputs include `parent` |
| `set record {fields}` | Assign named fields; no implied copies or model-name rebinding |
| `delete record` | Apply the model's declared deletion mode; allowed only if deletion is enabled |
| `call operation {arguments} [as name]` | Invoke a canonical operation in the same transaction/context; recheck its `by`, rules and ownership |
| `if expr` / `else` | Indented conditional branches |
| `for item in query limit=N` | Bounded loop; fail the entire operation if more than N items would be processed |
| `emit Event {fields}` | Persist one typed domain event for post-commit handling |
| `send Target.operation {arguments} [when=predicate] as delivery` | Persist a typed external delivery intent; returns a receipt, not provider success |
| `schedule key at=instant event=Event {fields}` | Replace one named pending occurrence at this owner; key is a text expression |
| `cancel key` | Cancel the named pending occurrence if not dispatched |
| `return expr` | Return one statically typed result and end evaluation |

Each scenario has one lowercase `do` execution body. An inline `do` may contain simple statements separated by `;`; a block `do` contains any statements. It replaces the earlier lowercase `then` spelling, which is no longer a body introducer. Leading `require` checks and the body execute in written order; further `require` checks may occur inside the body, including between effects. A failed check rejects the whole provisional mutation. `do` also introduces pure read bodies and trusted-handler bodies; it creates no additional transaction or authority. Attached `examples` stays outside the execution body and is test-only. Uppercase package `Then` still declares presentation. No nested `atomic`: a mutation is already one atomic unit at its inferred owner. No `clear`, `insert`, `upsert`, `append`, `snapshot`, `freeze`, arbitrary SQL/JS, or free-form effects. Collections stored by value are replaced through `set`; large mutable child collections are models.

Cross-package `call` is the only way to mutate another package's model. It participates in the caller's operation identity, invokes no network request, and cannot recurse. Direct parameter assignment is never storage mutation. A scenario cannot synthesize user privilege or trusted source status.

Every authored `require` has the same rejection semantics, including leading checks in trusted handlers. False means the safe business error, default `rule_failed`, and rollback of all provisional domain changes, events, deliveries and attachment links. A trusted business rejection is a terminal failed occurrence; transient runtime failures retry the same occurrence. Lifecycle `skipped` describes superseded/cancelled/ineligible work or a false dispatch `send when`, not a false authored `require`. Inline examples observe the ordinary business error, without committing rejected domain effects.

Mutation results default to a receipt plus authorized changed-record projections. Explicit mutation returns may contain literals, input values, generated receipts, and readable record values. Private authority-derived scalars cannot leak through return values; the compiler tracks these dependencies. A deliberate privileged report uses `scenario ... read=true scope=authority -> Contract by=...`: its typed result is an explicit information grant to `by`. Ordinary `read=true` uses viewer queries, allows only pure statements, and has a required result type and return on every path. Source-scoped reports must have a description identifying the information exposed. Mutation success/failure can inherently reveal the stated operation's permitted business outcome, such as availability; it never returns hidden rows or SQL diagnostics.

### 5.1. Inline behavior examples

`require` and `do` define production behavior. An attached `examples` block checks that behavior through concrete cases. It does not change the operation. This is the BDD testing surface: shared fixtures are Given, the operation is When, and expected observations are Then. Package Given/When/Then sections retain their declaration meaning; each example inherits its action rather than repeating those headers.

```can
Given
 Expense { amount:money, submitted_by:user, status:enum(submitted,approved)=submitted }
 role reviewer
 policy Expense read=members
 fixture pending=Expense {amount=money(25,"EUR"),submitted_by=other}
When
 # Approve a submitted expense from another teammate.
 scenario approve(expense:Expense) by=reviewer
  require expense.status==submitted and expense.submitted_by!=actor
  do set expense {status=approved}
  examples expense=pending
   as,expense.status,expense.submitted_by -> expense.status
   reviewer,submitted,other -> approved
   reviewer,approved,other -> error(rule_failed)
   members,submitted,other -> error(forbidden)
   reviewer,submitted,self -> error(rule_failed)
Then
```

There are two test-only declarations, with one way to express each:

- `fixture name=Model {fields}` in package Given describes shared initial records; `fixture name=file {}` provisions a finalized test file, as specified below. Model fixtures use the existing field rules, including defaults, explicit parent/reference bindings, and constraints. Required fields must be supplied; no solver invents valid business data. Fixtures may reference other fixtures; cycles are errors. Fixtures are visible only to examples, and their names cannot collide with production declarations.
- `examples parameter=value ...` inside a scenario supplies its common input bindings. A CRUD declaration uses `examples create`, `examples update`, or `examples delete` followed by common generated-input bindings. Optional `seed=[fixture,...]` includes initial records needed by collection queries even when they are not operation parameters; referenced input fixtures and their dependencies are seeded automatically. Multiple blocks are allowed for different datasets, with the same syntax. The first child line is the table header `inputSelectors -> observationExpressions`; remaining lines are rows `inputValues -> expectedValues`. Commas separate columns outside brackets/braces/parentheses. A row must match the header's arity.

The enclosing scenario/generated CRUD operation supplies the action and input schema. Header selectors name declared inputs, including whole typed contract/event values, generated CRUD changes such as `changes.title`, or fields of a fixture-bound record such as `expense.status`. Record-field selectors alter the row's **initial fixture state**, not the submitted update. Common bindings plus row values must supply every required operation input. Optional/defaulted inputs keep the operation's existing semantics. Input expressions are evaluated against the isolated initial state.

Each row gets a fresh team, deterministic accounts `self` and `other` in that team, and `outsider` in another team. These names are user references, not production globals. Fixtures are seeded as self; source `actor` defaults during seeding resolve to self. `as` selects the caller: `members`, `owner`, or a declared role invokes as self with that membership; an array such as `[owner,reviewer]` supplies combined roles; `public` is unauthenticated; `outsider` is the other-team account. Without an `as` column, the caller is self as an ordinary member. Fixture data and role selections are test-only; requests cannot grant themselves these identities.

Fixture instantiation and row state overrides must satisfy stored-data invariants. An invalid fixture fails setup; it does not count as the expected operation rejection. To test invalid inputs, change an operation input column. Input cells must have the declared representation type; business bounds and constraints are checked by the actual invocation, so an out-of-bounds input can be a rejection example. The runner loads referenced/seeded fixtures once per row, establishes their containment and references, and invokes the registered operation exactly once through its normal authorization/validation/commit path. Record IDs/current versions, operation identities, clock, and random defaults are deterministic test infrastructure. Fixtures start at version 1. `request` selectors can override declared wire-envelope fields, such as `request.expense.version` or `request.record.version`, to submit a stale version while preserving the real fixture version. They cannot create undeclared inputs or bypass validation.

Right-hand header expressions are read-only observations over freshly reloaded fixture records and `result`, the normal operation response. Expected cells are typed values independent of the implementation. A successful row requires operation success and compares every observation to its expected value. `error(code)` replaces the entire expected row: it requires that exact business error and verifies no domain writes, attachment relationships, committed events, or delivery intents were added or changed. Runtime rejection receipts/logs may still be recorded. Failing setup, unexpected errors, and failed assertions report the declaration, row, and mismatched observation.

Trusted handlers can attach examples using their inferred `event` input; the test runtime creates a typed verified source envelope and never exposes that capability through UI/MCP. External effects remain inspectable queued intents in the isolated state; examples do not dispatch live network calls. The runner does not substitute a different business implementation or skip policy checks. Provider delivery and the shared runtime's own concurrency/transport contracts are tested by that runtime's test suite; these tables make no claim to simulate all distributed failures.

Compilation emits a separate test artifact from fixtures/examples in the same source. Production execution and tool schemas omit them. Imported fixture members are test-only too: erase them before production import/dependency resolution and resource inference, omitting a group if no production members remain. Mixed groups retain the ordinary dependency semantics of their production members. The design adds no app-level test library, copied step definitions, separate test files, or generated expectations derived from `do`. Example count has no effect on app behavior. The initial parser recognizes this notation; fixture provisioning, semantic checks and the example runner remain implementation work. The notation below is not an executed business-test result.

For each row, evaluate all cells against its untouched seeded state, resolve fixture identities and input bindings, then apply independent row overrides together and validate the resulting setup once. Common input bindings establish the baseline and can be replaced by row selectors. Row-header selectors themselves must not overlap: reject duplicate paths, ancestor/descendant paths, and paths through different aliases that identify the same fixture field, even if supplied values happen to be equal. Assigning a reference edge conflicts with any other selector traversing that edge. Resolve alias conflicts against the untouched state, not against an earlier column's mutation. `request.*` changes the wire envelope and is distinct from fixture-state changes. Unsupported/conflicting selectors and invalid fixture setups are setup/compile diagnostics, never successful `error(code)` operation assertions.

For example, `event,event.reason` conflicts because it assigns both a whole value and a child; `booking.resource,booking.resource.active` conflicts because it changes a reference and traverses it. If two input bindings refer to the same seeded record, `left.title,right.title` conflicts. `booking.status,request.booking.version` is independent state/envelope setup. A common `event=fixture_value` plus the row selector `event.reason` remains legal; common bindings are the intentional baseline, not a second header patch.

```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:599–617

```text
Collection `defaults={filter=preferences.field}` initializes only controls already declared in `filter`. Each scalar/enum/reference value must match that control type; arrays/member filters are not covered by this extension. Null means no initial restriction. Explicit URL and current control state wins; clearing a filter remains cleared for that view rather than reapplying its default. Defaults are presentation, never extra query permissions or a required mutation input. Changed grants are checked again on every request.

Collections default to 25 rows, max 100, with identity/team/query-bound opaque cursors. Search is literal text over declared readable fields; filters are typed equality/range/enum inputs, not arbitrary client predicates. `order`, `search`, `filter`, `columns`, `empty`, `defaults`, and form `submit` are supported attributes; `display=split` belongs only to list/table. A page has a shared maximum of 500 rendered records and 1 MiB of response content; nested sections paginate/lazy-load rather than silently disappear. Runtime limits produce explicit errors where no partial display is meaningful. Query indexes derive from static query shapes and appear in generated migrations.

The operator requirements add one shared CSV-export contract: authorized list/table toolbars and typed read-result views supply export without per-app formatter code. Generated `Model.export` and `readScenario.export` reuse the same typed filters, row/field grants, scope and declared result schema. Export includes safe identifiers/versions and explicit currency/unit columns where applicable; it never widens access. A bounded export captures its read checkpoint, reports partial/unavailable source states, and must not label incomplete data complete. CSV quoting and spreadsheet-formula protection are runtime behavior. Large exports are persisted jobs with authorized expiring downloads; their limits and status are shared runtime configuration. No `.can` `export` statement, extra business write, or user-configurable SQL is introduced.

Authorized record-detail and typed read-result views also supply the shared Print control. It renders the selected declared content under current page, row, field and file grants, with readable labels, dates/currencies, record version and read time; native browser printing may save that presentation as PDF. Shell navigation, mutation controls, secrets and unrelated records are omitted. Only declared content is printed: apps that require complete minutes, ordered papers and amendments expose those through their actual read/view composition. Collapsed declared details can expand for printing. Print mode reruns its declared read-only collections under current grants at a bounded read checkpoint and traverses their pagination, using the shared export work/size limits rather than copying a 25-row guard into every app. It includes all matching rows of those declared collections or reports an explicit limit/incomplete result; it never labels a truncated screen page complete. Inactive tabs and undeclared related data are not inferred: a dedicated printable composition exposes the required sections through existing page syntax. A bounded read that fails or reports partial/unavailable cannot yield a complete-looking report. Printing does not run business operations, bypass file authorization or generate a new stored document. There is no authored print keyword, per-app renderer or document-provider binding for this standard presentation; existing attached files retain their own authorized download control.

`form Operation import=csv` adds a CSV intake mode beside the same canonical form. It is an explicit capability of that form, not a second CRUD definition or a batch business operation. The row schema derives from its target's writable inputs, defaults, typed references and already bound arguments. No source filename, copied import model or per-app parser is required. `review=readOperation` is optional and valid only with `import=csv`; it names an existing pure read scenario returning a model-record array. Its required parameter names/types must be a compatible subset of target inputs/bindings; optional unmatched parameters retain their declared defaults. A review never receives server fields or an invented draft-record identity. Its own `by` and ordinary readable row/field grants apply. A configured review that is unavailable or fails blocks that row instead of being skipped. Ordinary single-record submission retains the canonical operation's semantics; business uniqueness belongs in invariants/unique declarations, not in optional duplicate hints.

The generated import panel provides a template, explicit column mapping, typed editable row preview, excluded-row selection, validation messages, readable duplicate candidates and explicit confirmation. Template headers use stable input paths; translated captions are presentation. Duplicate/unknown headers and overlapping mappings are errors until explicitly corrected/excluded. Protected bound parent/record/identity arguments cannot be replaced by CSV. IDs and expected versions resolve through the same authorized reference controls; display labels never silently select records. No automatic merge, upsert or role transfer occurs. Exact repeated normalized input rows are flagged within the upload, while app-specific candidates come from the declared review operation. This review also serves manual resolution through already declared owning operations.

The pinned CSV profile is UTF-8 with optional initial BOM, a required header, comma separators and doubled-quote escaping as documented by [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180); CRLF and LF record boundaries are accepted, with quoted newlines preserved. No delimiter/locale guessing or formula evaluation. Input is bounded transient request data, not an attachable `file` and not an R2 MIME-policy bypass. V1 admits at most 10 MiB and 1,000 data rows per review; excess is an explicit limit error. Empty nullable cells mean null; nonnullable text keeps empty text and then applies its constraints. Omitted mapped columns use normal operation defaults or report required-input errors. Integers/decimals use exact canonical decimal text, booleans true/false, enums stable case names, dates/instants their pinned forms. Money and record references use typed leaf columns such as `amount.minor`/`amount.currency` and `customer.id`/`customer.version`. Arrays and structural value cells use the existing closed typed JSON wire representation, never executable expressions. Invalid values remain visible for correction. File/secret/action input cells cannot supply opaque authority: they need an existing protected form binding or an ordinary authorized control before confirmation. CSV export's formula protection does not license evaluation on import.

Preview performs schema/read checks and makes no domain writes; it cannot promise future guard success or bypass guards. Confirmation submits selected rows in source order through the original canonical operation, with one stable operation identity per row and current authorization/version/invariant checks. Each row is its own transaction. Report succeeded, failed, pending and unknown outcomes separately; earlier successes survive later failures. Retry retains row identity and frozen inputs, so uncertain outcomes reconcile rather than duplicate effects. Editing a successfully submitted row requires a new explicitly reviewed invocation. Before each row is submitted, rerun its configured candidate review against current state; changed candidates return that row for renewed confirmation. Thus a duplicate created by an earlier row remains visible rather than being silently accepted. Unchanged matches still require the recorded explicit create decision. Business concurrency remains governed by owning uniqueness/guards; review is not a lock or uniqueness claim.

Review state is private to the current authenticated user/app/team and expires after 24 hours; revoke access immediately on logout/context loss, retain recoverable drafts only while authorized, and never restore discarded private data through a later page poll. Operation receipts retain their existing independent lifetime/replay contract. The UI uses normal canonical operations also available through MCP; upload/session mechanics are transport controls, not additional CRUD tools. A selected form's review scenario follows the existing explicit-interface exposure rule. The generated JS form receives `import: 'csv'` and optional canonical `review` identity; its schema is not repeated in the UI target. Fixed parser/panel/status/confirmation wording belongs to the standard localized catalog.

Shared loading, empty, no-match, validation, failure, and conflict states are mandatory. Strings are escaped; enums and booleans have text-bearing labels; files use authorized links. History requires current record access and projects every entry through current readable-field grants, excluding hidden before/after values and all secrets. Keyboard behavior, focus trapping/return for drawers, field errors, responsive layout, and accessible names belong to runtime. [daisyUI components](https://daisyui.com/components/) supply CSS and markup patterns; the shared [daisyUI/Tailwind build](https://daisyui.com/docs/install/) supplies their assets. The mapping in REQUIREMENTS is canonical: Drawer/Menu/Modal for the sidebar and personal settings, Card/List/Table for records, Fieldset and typed inputs for forms, Button for actions, Badge for typed states, Collapse or activated Drawer for details, Tab for view panels and Stat for metrics. It does not supply every business interaction; drawer focus, keyboard dismissal and clipboard behavior remain runtime responsibilities. Charts, arbitrary rich text, editable opaque JSON, SDK setup widgets, and unconstrained visual editors are outside this v1 catalog.
```

## design/evaluation/baseline-20261004T041647Z/snapshot/DESIGN.md:729–741

```text
Every selected app provides one Streamable HTTP `/mcp` server. Packages contribute namespaced tools, not servers. The compiler emits one operation registry used by UI, MCP, generated routes, and internal calls. Product-selected packages contribute model read/list, enabled CRUD, and user scenarios as business tools; dependency exposure follows §1 rather than publishing every imported package's tools. Registry inclusion for internal execution does not itself imply tool discovery or a public route. With default teams support, owner-authorized `system.team.invite(email,role)`, `.remove(member)`, and `.role(member,role)` are also business tools with the same generated UI rules and mutation envelopes. Their fixed schemas come from the teams primitive. Login, recovery, session management, OAuth consent, source changes, and deployment stay browser/runtime interfaces and are never business tools. Hooks, timers, queues, instrumentation, provider events, and other trusted handlers are never tools.

MCP OAuth consent binds a connection to one app user and one team, or app-only context for a non-team app. Recheck current permissions for discovery and every call; another team requires a separate/re-authorized connection. Tokens have the correct audience and cannot impersonate a source. OAuth/protected-resource discovery follows the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). Browser sessions and MCP grants resolve the same principal model.

Tool names are stable `package.Model.read`, `.list`, `.create`, `.update`, `.delete`, and `package.scenario`. For an implicit package, `package` is its owning app identifier: `TeamTasks.Todo.create` is the same name standalone or within TeamOffice. Composition does not add a selected-app prefix, synthetic `main`, or mount alias. Named-package tools retain their existing names. Distinct canonical owners keep same-named models, roles and operations separate; deduplicated owners contribute a tool only once. The app description becomes initialization `instructions`; attached operation descriptions become tool descriptions. Model/field descriptions enrich generated schemas. `##` never leaves the source. File moves change no tool name. Names retain the [MCP tool-name conventions](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names); declaration renames are the explicit identity changes described in §1.

Schemas are closed typed JSON objects. Model reference inputs use `{id}` for reads and `{id,version}` for mutations; money uses integer minor units/currency; datetimes use RFC 3339 UTC strings; files use completed opaque IDs; union values have a discriminator. All int/decimal values use canonical decimal strings at the MCP boundary, including money.minor and record.version; there is no magnitude-dependent wire type. Booleans and collection counts defined by the protocol itself remain JSON booleans/numbers. Mutations have an `operation_id`; identity, roles, and team grants cannot be arguments. Generated CRUD update takes `{record,changes,operation_id}`; scenario business inputs are named alongside `operation_id`. Unknown arguments and undeclared writable fields fail.

An action value serializes as a closed discriminated reference whose target is one of the compiled canonical operations and whose protected binding is runtime-owned. Remote references include an opaque `action_handle`; clients cannot edit its protected contents. Discovery still exposes each canonical target tool once with its owner description/schema. Where ordinary and handle invocation are both exposed, the generated input schema is an explicit closed union: ordinary mode has the normal business inputs and `operation_id` without `action_handle`; handle mode has `action_handle`, `operation_id` and all non-record canonical inputs, omitting every protected record input. Otherwise expose only the available mode. An ordinary remote mode requires its own declared delegated access; an action handle does not authorize that mode. Mixed envelopes, wrong targets, record overrides, principal/team substitution and incompatible revisions fail. This gives a fixed remaining schema per target, without generic `perform(inputs:json)` tools or duplicated owner signatures.

Model list tools accept typed filters/order/cursor/limit constrained by readable fields, and a parent reference for children. Results reuse the UI query and projection rules. Every mutation result has `{status,operation_id,records,deliveries,result}` with applicable members present; its business `result` uses the declared type made nullable for absent, expired or withheld content (§7.1), and changed-record projections obey current access/lifetime. Pure reads return their declared shape. Business errors use structured codes (`validation`, `forbidden`, `not_found`, `conflict`, `rule_failed`, `busy`, `limit`, `delivery_unknown`) and actionable safe details with `isError=true`. Existence-hiding lookups return `not_found`. Protocol errors remain JSON-RPC errors. These choices follow [MCP tools/schema boundaries](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), not an additional app API definition.

## 11. Compiler output and change ownership
```

## design/evaluation/baseline-20261004T041647Z/snapshot/GRAMMAR.md:1–40

```text
# canlang v1 grammar

This is the normative source grammar for the bounded v1 language in [DESIGN.md](DESIGN.md). It specifies tokens, layout, syntactic roles and AST boundaries; DESIGN owns business semantics. A successful parse does not establish valid names, types, permissions, application behavior, deployed resources or executable examples. Unknown syntax is an error. No production permits an unparsed tail or an arbitrary extension word.

## Notation

EBNF uses `=` for a production, `|` for alternatives, `[x]` for optional syntax, `{x}` for repetition, and quoted text for exact source tokens. Uppercase names are lexical/layout tokens. `line(x)` means `x NEWLINE`. `suite(x)` means `NEWLINE INDENT x DEDENT`, with at least one source item. `optional_suite(x)` is either `NEWLINE` or `suite(x)`; lookahead at the next noncomment logical line determines which. `leaf_lines(x)` means a nonempty sequence of `line(x {";" x})`. These are grammar notation, not source words. End of file supplies a final `NEWLINE` when the final nonblank logical line lacks one.

`separated(x)` means `x {"," x}`. `bracketed(x)` means `[separated(x) [","]]` inside an explicitly written pair of delimiters. Empty bracketed lists are therefore possible. Trailing commas are allowed only inside `()`, `[]` or `{}`, not in an unbracketed attribute list or example row. An attribute named in the table below is present at most once per header. An omitted attribute is absent; it is not a syntactic assertion of a default.

## Tokens and layout

Source is UTF-8 with LF or CRLF line endings. A bare CR, malformed UTF-8, tab in indentation/code or backslash line continuation is an error. Tabs inside literal `#` prose or `##` content are prose, not indentation/code; `#=` path content and a description's inline translation suffix are syntax. JSON strings reject unescaped tabs and allow the escaped `\t` value. Outside strings, spaces separate tokens. Identifiers are case-sensitive ASCII:

```ebnf
NAME       = /[A-Za-z_][A-Za-z0-9_]*/ ;
INTEGER    = /[0-9]+/ ;
DECIMAL    = /[0-9]+\.[0-9]+/ ;
DURATION   = INTEGER ("ms" | "s" | "m" | "h" | "d") ;
BYTES      = INTEGER ("B" | "KiB" | "MiB" | "GiB") ;
STRING     = JSON double-quoted string ;
path       = NAME {"." NAME} ;
```

There are no single-quoted strings, literal physical newlines inside strings, source-interpolated strings, exponent-number literals or numeric separators. Message source/variant strings remain JSON STRING tokens; their ICU patterns are validated by a later compiler stage, never by general string scanning. Raw description prose has its separate marker rules below. A sign is an operator, never part of a numeric token. Strings obey JSON escapes, including `\u` escapes. Bounds, finite representation, Unicode scalar validity and unit overflow need validation beyond token recognition. A unit suffix must be adjacent to its integer; `5 m` is not a duration. Tokenization uses longest match, distinguishing `?.`, `??`, `->`, `==`, `!=`, `<=` and `>=` from their one-character prefixes. A numeric/unit token cannot consume an identifier prefix: `5minutes` is invalid, not `5m` followed by `inutes`.

All identifier-shaped words are `NAME` tokens. The parser assigns contextual roles as described below. Punctuation tokens are:

```text
( ) [ ] { } , . : ; = ! | + - * / % < > == != <= >= ?? ?. -> @
```

`/` is division in expressions and begins a route only in a route slot. Route segments have the additional lexical rule defined below. `#` is recognized only as a physical-line marker, outside strings. `@` is valid only as the contiguous `@{` message-variant marker following a source string or final description prose; it is not a general object annotation.

At delimiter depth zero, a physical newline ends a logical line. Open balanced `()`, `[]` or `{}` join physical lines; they do not introduce a block. Continuation indentation has no layout meaning. A mismatched closer or unclosed delimiter is an error. Tokens retain their original physical line and column even when joined.

On noncontinued source lines, a block increases the preceding header's indentation by exactly one space. Dedentation must return to an existing indentation level. The first top-level declaration starts at column zero. Blank lines and full-line comments emit no `INDENT`, `DEDENT` or statement. Their indentation does not open or close suites. A suite belongs to one compound header, not to a semicolon sequence.

### Descriptions and comments

```

## design/evaluation/baseline-20261004T041647Z/snapshot/GRAMMAR.md:99–150

```text
| scenario examples | `examples` | named input bindings `NAME=expr`, `seed=expr`; seed must resolve to a fixture list |
| CRUD examples | `examples (create or update or delete)` | named input bindings `NAME=expr`, `seed=expr`; seed must resolve to a fixture list |
| page | `page route` | `title=expr` **required**, `data=expr`, `order=expr`, `group=expr`, `nav=NAME`, `poll=expr`, `refresh=path`; refresh names a canonical user mutation and requires poll; nav supports only none, order is a constant integer, poll is a constant duration from 1s through 1h; title must be literal text or a message value, data a pure read call |
| card | `card expr` | `layout=NAME`; supported values are stack/columns |
| details | `details expr` | `display=NAME`, `open=expr`; drawer is the sole display exception, open applies only to Collapse |
| tabs | `tabs [expr]` | none; leaf requires an enum preference selector, otherwise tab suites required |
| tab | `tab expr` | none; nonempty suite, directly inside tabs only |
| list | `list expr` | `columns=selectors`, `order=ui_order`, `search=selectors`, `filter=selectors`, `empty=expr`, `defaults=values`, `display=NAME`; split is the sole display exception |
| table | `table expr` | `columns=selectors` **required**, `order=ui_order`, `search=selectors`, `filter=selectors`, `empty=expr`, `defaults=values`, `display=NAME`; split is the sole display exception |
| board | `board expr` | `by=selectors` **required**, `columns=selectors`, `order=ui_order`, `search=selectors`, `filter=selectors`, `empty=expr`, `defaults=values`; by must resolve to one enum field |
| calendar | `calendar expr` | `start=selectors` **required**, `end=selectors` **required**, `columns=selectors`, `order=ui_order`, `search=selectors`, `filter=selectors`, `empty=expr`, `defaults=values`; each endpoint must resolve to one field |
| form | `form expr` | `arguments=values`, `fields=selectors`, `submit=expr`, `display=NAME`, `import=NAME`, `review=path`; inline is the supported display value, csv the sole import mode; review requires import=csv |
| edit | `edit` | `fields=selectors` |
| migration | `migration NAME` | `from=STRING` **required** |
| context theme | `theme` | at least one of `mode=NAME`, `accent=NAME`, `density=NAME`; mode must be system/light/dark, accent blue/green/purple, density comfortable/compact |
| context file policy | `files` | at least one of `types=STRING`, `max=expr`; max must be a positive byte quantity |
| context owner binding | `binding NAME DurableObject` | `key=path` **required** |
| context queue | `queue NAME` | `type=type` **required** |
| context cache | `cache KV` | `ttl=expr` **required**; a positive duration is required semantically |
| context analytics | `analytics NAME schema` | none |
| context locale | `locale` | `default=STRING` **required**; canonical BCP 47 value/difference validation is semantic |

Finite value lists in the table describe semantic alternatives; `/` within such a list is not part of the attribute spelling. Resource references, positive intervals, actual changes from pinned defaults, media-type allowlists, field-selector validity and context conflicts require semantic checks. There is no syntax for repeating unchanged `runtime`, `database D1`, `auth email password`, `teams`, R2 or the default theme setup. Queue/telemetry quotas and adapter implementation mappings belong to deployment contracts, not an unspecified attribute bag.

For an expression-valued header slot, a current-depth `NAME "="` after a complete expression begins the next attribute. Nested delimiters isolate their own named arguments/fields. The candidate attribute is checked against this table, so an unknown attribute is rejected rather than swallowed. A binding marker `as NAME`, the scenario `->` result marker, and a schema/value brace expected by that production also end the preceding slot. An operator requiring a right operand must obtain it before a boundary can terminate its expression.

An attribute value never crosses its enclosing comma, closing delimiter, semicolon, logical newline or dedent. Different token sequences `=` and `==` prevent assignment/attribute boundaries from splitting comparisons. A new attribute after a comma is not accepted: unbracketed selector-list commas belong to that list. Thus `fields=a,b when=predicate` is valid, and `fields=a,b, when=predicate` is invalid.

## Files, composition and sections

```ebnf
file_source     = {app_composed | app_implicit | package | migration} EOF ;
app_composed    = line("app" NAME app_attributes)
                  [context] {line(import {";" import})} ;
app_implicit    = line("app" NAME app_attributes) [context] {line(import {";" import})} sections ;
context         = "context" suite(context_items) ;
context_items   = leaf_lines(context_declaration) ;
context_declaration = "theme" attributes | "files" attributes | "locale" attributes
                    | "binding" NAME "DurableObject" attributes
                    | "queue" NAME attributes | "cache" "KV" attributes
                    | "analytics" NAME schema ;
package         = "package" NAME attributes suite(package_body) ;
app_attributes  = attributes with uses present for app_composed and absent for app_implicit ;
package_body    = {line(import {";" import})} sections ;
sections        = section_given section_when section_then ;
section_given   = line("Given") given_items ;
section_when    = line("When") when_items ;
section_then    = line("Then") then_items ;
then_items      = {then_item} ;
import          = "use" path "{" import_members "}" ["from" "=" path] ;
import_members  = separated(import_member) [","] ;
import_member   = NAME ["as" NAME] ;
```

## design/evaluation/baseline-20261004T041647Z/snapshot/GRAMMAR.md:165–235

```text
enum_type        = "enum" "(" separated(NAME) [","] ")" ;
action_type      = "action" "(" separated(path) [","] ")" ;
field_type       = type ["!"] ;
schema           = "{" bracketed(field) "}" ;
field            = NAME ":" field_type [initializer] {field_modifier} [field_label_attribute] ;
initializer      = "=" expr | "server" "=" expr ;
field_modifier   = "trim" | "unique" | "min" "=" expr | "max" "=" expr ;
parameters       = "(" bracketed(parameter) ")" ;
parameter        = NAME ":" type ["=" expr] [field_label_attribute] ;
```

`enum(...)` and `action(...)` are recognized by their exact call-shaped type production. A bare type path component named `enum` or `action` is not globally banned. Their atom forms are not union arms. Union `|` combines all named paths before array/container suffixes: `A|B[]?` means a nullable array of union values. There are no grouped types, repeated array suffixes or nullable-element spelling `T?[]`. A scalar may have `?` without an array. Enumerator/allowed-action lists are syntactically nonempty, and enum entries are unqualified names. Checking requires distinct values and valid canonical action targets. Union arms must resolve to the supported tagged named value types; primitive unions are not authorized by their syntactic path shape.

The trailing field `!` is creation metadata, not a value-type operator. `text!`, `text?!`, `text[]?!` and repeated `!` are invalid; an explicitly written nonnullable array can use `text[]!`. A qualified field path whose representation is unresolved can be parsed with `!`, as in `items:Contract.rows!`; later checking must prove that the reused field is a nonnullable array. A required-array-input field cannot also have a default or server initializer. A syntax-only parser must not claim it knows an unresolved path's representation.

Suffixes act on the resolved value, including inherited field types. Applying `[]` to an already nullable value or array is forbidden. Applying `?` to an already nullable value is redundant and invalid. A reused nonnullable array may acquire container nullability or the field-only required marker, but not both. These rules prevent qualified field reuse from smuggling nested arrays or nullable elements into the subset. Reuse retains representation/nullability and normalization/value bounds, but never the old initializer, required-array-input marker, server ownership, uniqueness, scope or policy.

Fields may have one initializer and one occurrence of each modifier; initializers precede modifiers. A field default or bound is delimited by the next field modifier at current depth or the schema comma/closer. Bare `trim`/`unique` terminate the preceding complete value just as `min=`/`max=` do. Type checking determines compatible modifiers, default values, nullability and initialization obligations. Schema fields use colons and require commas, including between fields on joined physical lines. An optional `label=` follows its initializer/modifiers and delimits a preceding complete expression. A field description does not replace its comma.

Parameters have no field-only `!`, server initializer or field modifier list; their optional trailing `label=` follows any default. Their required/defaulted/nullable input behavior comes from their signature and DESIGN. Capability operation signatures use `NAME parameters "->" type`, pure functions parse `derive path parameters ":" type "=" expr`, and scenario signatures use the table's header attributes/result annotation. Checking must establish a valid owning function name for a parsed derive path; a path is not an automatic cross-package extension. Parameters and defaults must resolve and type-check; parameter spelling never infers a type.

## Expressions and values

The following productions are syntactic. Their apparent function/type paths require later resolution; constructors, functions and operation identities are not inferred from an attractive name.

```ebnf
expr           = ordinary [query_tail] ;
ordinary       = fallback ;
fallback       = disjunction ["??" fallback] ;
disjunction    = conjunction {"or" conjunction} ;
conjunction    = negation {"and" negation} ;
negation       = "not" negation | comparison ;
comparison     = additive [comparison_op additive] ;
comparison_op  = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "is" ;
additive       = multiplicative {("+" | "-") multiplicative} ;
multiplicative = unary {("*" | "/" | "%") unary} ;
unary          = "-" unary | postfix ;
postfix        = primary {"." NAME | "?." NAME | arguments} ;
primary        = INTEGER | DECIMAL | DURATION | BYTES | STRING [message_variants]
               | "true" | "false" | "null" | VALUE_NAME
               | "(" expr ")" | array | values | typed_value ;
array          = "[" bracketed(expr) "]" ;
values         = "{" bracketed(value_field) "}" ;
value_field    = NAME ["=" expr] ;
typed_value    = VALUE_NAME {"." NAME} values ;
VALUE_NAME     = NAME except "true", "false", "null", "not" ;
arguments      = "(" [positional ["," named_arguments] [","]
                      | named_arguments [","]] ")" ;
positional     = separated(expr) ;
named_arguments = separated(NAME "=" expr) ;
call_expr      = postfix with a final arguments suffix ;
```

The call-argument parser detects `NAME "="` at an argument's start before choosing a positional expression. Once that form occurs, remaining arguments must be named; duplicate names are invalid. Empty calls and a trailing comma after positional arguments are allowed. The displayed argument production is interpreted with this lookahead, so the positional list cannot consume a named argument as an expression. Assignment is absent from `expr`.

`path values` wins over a plain name/member expression when the path is immediately followed by `{` in an expression slot. It creates a typed structural value. In schema slots, `{` uses `field`; in value slots, `{` uses `value_field`; route slots use their separate production. `{field}` is shorthand for `{field=field}`. Colons are not a structural value spelling, and equals signs are not schema field separators.

No postfix indexing, optional calls, optional indexing, arbitrary JavaScript or assignment expression is present. A call suffix cannot follow a safe member suffix to form `receiver?.method(...)`; an ordinary call on a safe-access result also requires a compatible callable type, which v1 does not introduce. Array access uses `at(array,index)`. Safe access is read-only and cannot form a mutation target.

Binary arithmetic/boolean operators associate left; `??` associates right. Comparisons are nonassociative: `a<b<c` fails, including mixed chains such as `a==b in c`. `is` has this syntactic precedence but its right operand must resolve to the permitted type-test target. In each unparenthesized expression segment, mixing `??` with `and` or `or` is invalid. Parentheses and separate call arguments establish new segments. There is no implicit coercion/truthiness. Safe access, null narrowing, enum expectation and all operator types are semantic checks.

### Queries and scope

```ebnf
query_tail    = [archive_clause] [alias_clause] [where_clause]
                [order_clause] [select_clause] ;
archive_clause = "archived" "=" "include" ;
alias_clause  = "as" NAME ;
where_clause  = "where" ordinary ;
order_clause  = "order" "=" ordinary ;
select_clause = "select" ordinary ;
```

## design/evaluation/baseline-20261004T041647Z/snapshot/GRAMMAR.md:261–340

```text
invariant      = "invariant" path ":" expr ;
unique         = "unique" path attributes ;
lock           = "lock" path attributes ;
retain         = "retain" path attributes ;
fixture        = "fixture" NAME "=" (path values | "file" values) ;
capability     = "capability" NAME attributes suite(capability_items) ;
capability_items = leaf_lines(capability_leaf) ;
capability_leaf = NAME parameters "->" type | event ;
```

Here and below, `attributes` expands only the row for that header in the closed table; it is not a generic NAME/value bag. `given_items` consists of leaf lines and capability compounds. `capability_items` is a nonempty sequence of capability items. A field derive target must resolve to `Model.field`; syntactically its path need not be classified by length. A pure function is distinguished by its parameter parentheses. `invariant path: expr` is the sole Given invariant spelling; the former `require path: expr` is invalid. Its target path, colon, expression and `row` scope are unchanged. Execution/mapper guards and presentation gates retain `require`. Both words remain contextual names in name slots. `in team`, a role scope attribute, and arbitrary resource declarations in Given are invalid. `in app` is the explicit app scope; a model path denotes explicit containment. `at` and containment compatibility are semantic.

File-fixture recipes reuse the value-object syntax. Their parsed fields must later validate as only `type=STRING` and `owner=(self|other|outsider)`; unknown recipe fields and inappropriate shorthand/value shapes are semantic errors. Duplicate object fields are syntactically invalid for every object. An empty recipe is valid. Other fixture objects use named/shorthand input fields and require ordinary model/constraint/fixture resolution. There is no production file constructor. Test-only fixture identities are not production globals.

## Inline messages, labels and locales

```ebnf
message          = "message" NAME [message_parameters] "=" message_value ;
message_parameters = "(" separated(parameter) [","] ")" ;
message_value    = STRING message_variants ;
message_variants = "@" "{" [separated(message_variant) [","]] "}" ;
message_variant  = (NAME | STRING) "=" (STRING | "null") ;
caption          = STRING [message_variants] | path ;
scalar_label_attribute = "label" "=" caption ;
field_label_attribute = "label" "=" field_label_value ;
field_label_value = caption | "{" separated(field_label_entry) [","] "}" ;
field_label_entry = "text" "=" caption | "values" "=" case_labels ;
case_labels      = "{" separated(case_label) [","] "}" ;
case_label       = NAME "=" caption ;
crud_labels      = "{" separated(crud_label_entry) [","] "}" ;
crud_label_entry = ("create" | "update" | "delete") "=" caption ;
```

A named message is a Given leaf and may be individually exported; there is no locale-column container or `for` label-binding production. Its right side requires the explicit descriptor suffix, including `@{}` for a source-only asset. Models named `message` still select the model production when followed by schema/ownership shape. The `@{` marker is contiguous; ordinary spaces may separate a quoted source STRING from its suffix. Keys are simple language identifiers or quoted language tags such as `"pt-BR"`; strings/null are explicit variant/absence values. Empty suffixes and trailing commas inside braces are legal. Case-insensitive duplicate literal keys fail syntactically; BCP 47 canonical aliases, source-tag duplication and locale-data support require semantic checks. Message namespace collisions, parameter representations, patterns, variables, formatter compatibility and coverage require the checker.

Scalar `label=` slots parse only a literal source STRING with optional descriptor suffix, or a static path; calls and arbitrary expressions are invalid. Field/parameter labels additionally admit the closed object with exactly `text=caption` and/or `values={case=caption,...}`, with at least one member and nonempty case entries. CRUD labels require a nonempty closed object containing only `create`, `update` and/or `delete` captions. Unknown keys and duplicate entries/case keys are structural errors. Resolving a path to a zero-parameter message, validating enum/bool case ownership, inherited overrides and enabled CRUD operations remain semantic checks; enum syntax is unchanged. Case keys are stable wire values, including `true`/`false` for bool. Declaration-local attributes replace target-path label lists, and equal complete captions may reference a shared message. No label changes machine identity or access.

`source=STRING` belongs to app/package headers, defaulting to `"en"` per logical owner. Its validation and annotation of owned assets/attached prose are semantic; imported or composed owners retain their own source language. `locale` is a normal type-path name whose canonical BCP 47 value rules come from DESIGN §9.1. Its context declaration uses `default=STRING` above and controls deployment fallback/viewer selection only.

Text caption/submit/empty/diagnostic slots parse expressions; checking accepts literal text or message values and rejects other results. No configuration-wide localization is implied. Message references and calls reuse expression grammar. Anonymous descriptor calls require a nonempty list of explicit named arguments, with types resolved from their expressions and every placeholder across variants explicitly bound; there is no implicit capture. Named messages use their declared typed signatures. The initial parser does not parse ICU internals, resolve pure message import closure, execute fallback/formatting, or certify translations.

## When declarations and execution

```ebnf
when_items      = {line(crud_head {";" crud_head}) | crud_head suite(crud_examples)
                  | user_scenario | trusted_scenario} ;
crud_head       = "crud" path attributes ;
user_scenario   = ["export"] "scenario" NAME parameters attributes suite(scenario_body) ;
trusted_scenario = "scenario" NAME attributes suite(scenario_body) ;
handler_source  = path | "every" "(" DURATION [","] ")" ;
scenario_body   = {guard_line} do_body {scenario_examples} ;
guard_line      = line(guard {";" guard}) ;
guard           = "require" expr ["message" "=" expr] ;
do_body         = "do" (line(effect_leaves) | suite(effect_body)) ;
effect_body     = {effect_line | conditional | loop} ;
effect_line     = line(effect_leaves) ;
effect_leaves   = effect_leaf {";" effect_leaf} ;
effect_leaf     = let | guard | create | set | delete | call | emit | send
                | schedule | cancel | return ;
let             = "let" NAME "=" expr ;
create          = "create" path values "as" NAME ;
set             = "set" mutation_target values ;
delete          = "delete" mutation_target ;
call            = "call" ordinary values ["as" NAME] ;
emit            = "emit" path values ;
send            = "send" ordinary values ["when" "=" ordinary] "as" NAME ;
schedule        = "schedule" expr "at" "=" expr "event" "=" path values ;
cancel          = "cancel" expr ;
return          = "return" expr ;
conditional     = "if" expr suite(effect_body) ["else" suite(effect_body)] ;
loop            = "for" NAME "in" expr "limit" "=" expr suite(effect_body) ;
mutation_target = path ;
```

The table's `on=source` slot uses `handler_source`. Each effect suite is nonempty. `else` occurs at the same indentation as its paired `if` immediately after that suite, ignoring blank/comments. No `else if` shortcut is introduced; write a nested `if` in the `else` suite. The mandatory `limit` slot parses an expression whose value must be a positive integer within the work budget. It is not a query clause. Loop query expressions end at `limit=`. Call/send targets parse ordinary expressions with unparenthesized typed construction disabled so their following argument object remains a distinct effect slot; later checking requires a valid operation/action reference. A delete path must resolve to a permitted mutable record target.

There is exactly one `do` per scenario. `let` before `do` is invalid. Leading guards and statements inside `do` retain written order. Attached examples come after execution and cannot be effects. An inline `do` admits only semicolon-separated simple effects; `if` and `for` require indented suites. A single inline effect cannot receive a child suite. `set` and `delete` have path targets; invocation targets have their separate ordinary-expression slots above. Parsing a path/expression never establishes a writable record or authority-bearing operation. Safe access remains a read-only expression rather than writable field access. Record ownership/mutability and special `event.after` behavior require checks.

User scenarios require parameter parentheses even when empty and a `by` expression. Trusted scenarios have no authored parameters and use `on=source`; `by` and `on` cannot coexist. Capability/CRUD sources and `.completed` suffixes are parsed as paths, then validated against the finite source registry. Read return requirements, permissible read effects, synchronous call cycles, remote/local targets and all authority rules remain semantic work.

```

## tools/can_parser.py:1–90

```text
#!/usr/bin/env python3
"""Initial canlang syntax parser. No symbol/type checking or runtime execution."""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
from pathlib import Path
import re
import sys


@dataclass(frozen=True)
class Token:
    kind: str
    text: str
    line: int
    column: int
    path: str
    value: object = None


class ParseError(Exception):
    def __init__(self, token, message, code="syntax"):
        self.token, self.message, self.code = token, message, code
        self.line, self.column = token.line, token.column
        super().__init__(f"{token.path}:{token.line}:{token.column}: {code}: {message}")


@dataclass
class Node:
    kind: str
    token: Token
    data: dict

    def to_dict(self):
        def convert(value):
            if isinstance(value, Node):
                return value.to_dict()
            if isinstance(value, list):
                return [convert(v) for v in value]
            if isinstance(value, dict):
                return {k: convert(v) for k, v in value.items()}
            return value
        return {"kind": self.kind, "location": {"file": self.token.path,
                "line": self.token.line, "column": self.token.column},
                **convert(self.data)}


def node(kind, token, **data):
    return Node(kind, token, data)


@dataclass
class Line:
    indent: int
    tokens: list[Token]
    children: list[Line] = field(default_factory=list)


_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_NUMBER = re.compile(r"[0-9]+\.[0-9]+|[0-9]+(?:GiB|MiB|KiB|ms|B|s|m|h|d)?")
_SYMBOLS = ("?.", "??", "==", "!=", "<=", ">=", "->")


def lex(source, path="<input>"):
    """Return logical lines, preserving physical field descriptions in braces."""
    source = source.replace("\r\n", "\n")
    if "\r" in source:
        prefix = source[:source.index("\r")]
        raise ParseError(Token("", "\r", prefix.count("\n") + 1,
                               len(prefix.rsplit("\n", 1)[-1]) + 1, path),
                         "bare carriage return is not a line ending", "lexical")
    lines, pending, brackets = [], [], []
    indent = 0
    for number, physical in enumerate(source.split("\n"), 1):
        leading = len(physical) - len(physical.lstrip(" "))
        body = physical[leading:]
        if not body:
            continue
        if body.startswith("##"):
            continue
        if body.startswith("#"):
            description_text = body[2:] if body.startswith("# ") else body[1:]
            description = Token("DESC", body, number, leading + 1, path, description_text)
            if brackets:
                pending.append(description)
            else:
                lines.append(Line(leading, [description]))
            continue
```
