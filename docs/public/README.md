# Public handbook authoring contract

The CanLang repository owns this public user handbook; the Soda OS website publishes a pinned snapshot under `/docs/canlang`.

## Publication boundary

Only numbered Markdown pages inside this directory are handbook content. This README describes the export contract and is not a published page. Engineering records, research, draft implementation status and the rest of the repository are outside the public export.

The handbook describes the accepted finished-product contract. Keep current implementation gaps and release qualification in engineering records; do not turn temporary limitations into permanent public semantics. [FILETREE.md](FILETREE.md) records page ownership and the source-informed structure and is also excluded from publication.

Use `NN-Section/NN-slug.md` paths. Section and page numbers establish reading order. Every page slug must be unique across sections; exactly one `NN-index.md` supplies the handbook landing page. Its website path is `/docs/canlang`; other pages use `/docs/canlang/slug`.

## Page structure

Start each published page with one H1 title and one plain description paragraph. Use H2 and H3 for content, fenced code blocks with language labels, ordinary Markdown links, tables and lists. Do not add raw HTML, custom JSX, framework components or hidden metadata.

Use relative `.md` links for other pages inside this directory. Preserve the target filename and add a heading fragment when useful. Do not link to this README as handbook content. External reference links must use HTTPS.

## Source ownership

Write user instructions here so they are complete in both the source checkout and website snapshot. The normative grammar owns exact syntax; language design owns semantics; UI and Values catalogs own their signatures and profiles. Summarize and link those references instead of maintaining another construct-help card registry. Preserve the existing registry's identifiers and authored prose ownership.

Clearly identify a complete application, a source fragment and a composition declaration requiring other owners. Commands must name actual prerequisites and distinguish source checking, emission, local preview and remote deployment. Validate complete examples with the existing compiler when available and record the verification scope without treating one example as whole-product qualification.

## Example progression and continuity

[The reader's example progression](01-Get-started/02-example-progression.md) owns discovery and source classifications. Use this progression when expanding the handbook; avoid inventing an unrelated model for every chapter.

| Teaching stage | Application and authoring scope |
| --- | --- |
| Fundamentals | Keep `Tasks` and its `Todo` model across the first-app and guarded-workflow tutorials. Publish each stage as complete replacement source; make schema changes explicit. |
| Business permissions and relationships | Use `ExpenseFlow` for requester/reviewer identity, policies, money, submission, decisions and reporting. Its existing source owns the baseline. Use the complete `ExpenseData` companion in the models-and-relationships lesson for an `Expense` reference to `CostCentre`, contained `ExpenseLine` records, and contract/union values. Keep it explicitly separate from `examples/ExpenseFlow.can`; its source is a data-modeling application, not an approval workflow. |
| Presentation and composition | Keep task-oriented preferences, localization and app composition in `TeamTasks`/`TeamNotes`/`TeamOffice`. Use `ActionForms` and `ActionGallery` for focused control-placement examples. |
| Build-time generation | Use `PromptStudio`, available as a branch immediately after Tasks. Teach traits, keywords, styles and views in small steps, retaining the owning source, settings and saved implementation. `examples/Generation.can` belongs to state-machine teaching. |
| External integrations | Extract a small account-read/send/completion tutorial from `CanSync` before introducing its reviewed write/reconciliation flow. Declare the required `AccountsV1` provider binding explicitly. |
| Runtime AI and retrieval | Use focused workflows from `CanChat` for typed generation/progress/recovery and from `CanKnowledge` for published revisions/corpus access. State provider/file prerequisites. Keep the larger sources as advanced references rather than pasting them into introductory pages. |

Each new source fragment must name its parent application/version, insertion section and referenced declarations. A sequence of fragments must lead to a complete source listing. Keep table and sequence `examples` distinguishable from application source and browser seed data.

Extend ExpenseFlow with supporting files or notifications only in the relevant integration lesson. Do not make provider credentials or code generation prerequisites for the core Tasks/ExpenseFlow path. The seven recipes link complete source and state their setup, verification and deliberately bounded behavior.

Historical fixture README claims, generated illustrative screenshots and design documents are not runtime qualification. Recheck the specific source and dependency set used by a tutorial; record current implementation limitations in engineering material while retaining the accepted final-product contract in the handbook.

Classify examples by their authored form and declared dependencies, not by temporary compiler or runtime failures. Such failures belong in engineering records and must not downgrade accepted capabilities in the public teaching path. Source checks do not qualify browser or live-provider behavior.

## Changes and snapshots

Correct this source first, then refresh the website's generated snapshot from a committed revision. Keep the generator reproducible and link-safe; do not hand-edit copied website handbook content. The website owns presentation and routing, while CanLang owns language and handbook content. This publication decision does not change language capabilities or deployment targets. Machine-readable discovery files are deferred until separately requested.
