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

## Changes and snapshots

Correct this source first, then refresh the website's generated snapshot from a committed revision. Keep the generator reproducible and link-safe; do not hand-edit copied website handbook content. The website owns presentation and routing, while CanLang owns language and handbook content. This publication decision does not change language capabilities or deployment targets. Machine-readable discovery files are deferred until separately requested.
