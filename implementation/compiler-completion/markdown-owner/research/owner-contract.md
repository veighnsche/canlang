# OUT-R03 downstream Markdown owner qualification

Status: verified failure and research proposal; production implementation unreleased.
Observed HEAD: `b7e18b9b7da7af07ec7e0672347e2d6f173b3ae2`.
The source hash and complete 28-case Markdown/HTML/DOM observations are in `raw.json`.

## Owner and complete helper family

Production owner: `packages/interfaces/src/docs/reference.ts`; focused existing tests: `packages/interfaces/test/docs-reference.test.ts`. Both had clean Git status before and after research. Foreign package work elsewhere does not authorize overlapping changes. Only these two production paths need release; no compiler, contracts, CLI, package manifest, dependency, decision-log or Git edits belong in the leaf.

Public export: `packages/interfaces/src/index.ts:32`. Actual downstream caller: `packages/cloudflare/src/cli/docs.ts:133` dynamically resolves the package export and emits Markdown to stdout. `docs/install.md:75` advertises stdout or output-file Markdown. DESIGN descriptions and existing decisions identify that same public renderer. No designated HTML viewer or parser was found in this owner/CLI/advertised-document family; the repository lock/manifests do not provide marked, markdown-it, remark-gfm or commonmark. This is a Markdown-generation contract, not a claim to support every Markdown implementation.

Complete code helper call family, from current source:

| Context | Values | Current locations |
| --- | --- | --- |
| Metadata lists | source revision, catalog version, language version, requested locale, app default locale | 736–740 |
| Source lists | source ID (declaration and operation) | 557 |
| Headings | qualified declaration name, operation ID, owner name | 568, 643, 689 |
| TOC links | owner name, qualified declaration name, operation ID | 747, 750, 753 |
| Example labels | declaration and operation labels | 627 |
| Result paragraph | result type | 674 |
| Availability lists | owner, catalog | 714–715 |
| Declaration table | field name, type, authored default | 594 |
| Operation input table | input name, type, authored default | 668 |

`escapeMarkdown` (158) separately owns descriptions and constraint prose, including HTML neutralization; shared localized headings remain module-owned. `codeBlock` (492) separately selects a fence longer than authored backtick runs for source/expected examples. None requires redesign.

## Verified meaning

Qualification oracle: existing desktop dependency bundle `marked` 17.0.5 with `{gfm:true, breaks:false}`, independently parsed to HTML and then existing repository `happy-dom` DOM `textContent`. This is an external qualification oracle, not a newly installed dependency or a previously designated Can viewer. Tests call the actual source public `renderReferenceMarkdown`; the research candidate substitutes only helpers and six table code call arguments in memory, transpiles with existing TypeScript, and calls the resulting public function. Assertions inspect DOM code text and all seven table cells, not implementation-mirroring regex expectations.

28 bounded cases cover 1/2/3/8/17/64 backtick runs, mixed runs, leading/trailing/internal/all spaces, empty strings, pipes and repeated pipes, one/two/three literal backslashes before pipes, backslash elsewhere, backtick/pipe combinations, link syntax and HTML-looking text. Each value reaches metadata inline code and both tables' name/type/default plus description cells. The baseline preserves 8/28 inline-and-table cases; candidate preserves 28/28, both tables remain seven columns, authored prose remains literal, and source/expected fenced-example text and bytes stay unchanged. Existing built focused renderer tests pass 49/49 (`baseline-tests.txt`); that built suite is a baseline check, not fresh implementation validation.

Important negative control: adding one backslash before every table pipe fails for odd authored backslash runs before a pipe in the actual marked GFM consumer, splitting cells. Therefore dynamic fences plus universal `replace('|', '\\|')` are insufficient to close this packet.

## Proposed smallest released leaf

Replace `escapeCodeSpan`/`codeSpan` with a context-aware helper. For nonempty ordinary inline values, choose a backtick delimiter longer than every authored run; preserve literal backslashes; pad when either edge is a backtick, or both edges are spaces in a non-all-space value. Padding compensates CommonMark's single-edge-space stripping. All-space values receive no extra padding.

For empty strings and pipe-bearing table code values, emit `<code>` with authored ASCII punctuation encoded as numeric entities. This prevents Markdown/HTML interpretation and table splitting while retaining DOM text, including literal backslashes. Existing generated anchors already require inline HTML support; the oracle accepts this fallback. For other table values, reuse ordinary code-span handling. Pass table context at the three code-bearing values in each of the two table call sites only. `candidate-helper.txt` records the qualified research helper, not a mandated final coding style.

Acceptance for release: public renderer behavior above; regression examples for arbitrary backtick runs, literal backslashes, pipe/backslash combinations, empty/all-space/edge-space values; meaningful parsed-consumer replay via this saved oracle; existing focused tests and owner typecheck. No new package dependency is necessary. Repository unit tests may check exact output encodings for the standards contract, but those alone do not replace the independent parser replay. Keep descriptions, constraint escaping, locale/headings, anchor resolution, source offsets, authored-default identity and fenced examples.

Scope boundaries: exact DOM text for tested single-line strings and table shape under the specified consumer/dialect. Browser CSS may collapse spaces visually; this does not certify pixel display. CommonMark itself lacks GFM tables. Multiline code spans normalize line endings by standard; raw newline-bearing table values cannot be claimed byte-preserving by this leaf. No universal consumer conformance, new viewer policy, compiler JSON change, source-to-CLI rerun, publication or merge is claimed.

## Reproduction and primary standards

From repository root with current Node 24:

```
node implementation/compiler-completion/markdown-owner/research/reproduce.mjs
node --test packages/interfaces/dist/test/docs-reference.test.js
git status --short packages/interfaces/src/docs/reference.ts packages/interfaces/test/docs-reference.test.ts
```

The first command rewrites only this research folder's raw evidence and candidate helper. The bundled marked path is intentionally explicit and host-dependent; it can be changed to another existing equivalent parser path without adding a project dependency. Expected candidate summary: 28/28; baseline summary is tied to the captured owner source hash and will change after implementation.

Verified primary references, 2026-10-07: [CommonMark 0.31.2 code spans](https://spec.commonmark.org/0.31.2/#code-spans) defines equal delimiter runs, line/space normalization and literal backslashes; [GFM tables](https://github.github.com/gfm/#tables-extension-) defines pipe cell boundaries and escaped pipes even within inline spans; [CommonMark raw HTML](https://spec.commonmark.org/0.31.2/#raw-html) defines inline tag handling; [marked supported specifications](https://marked.js.org/#specifications) identifies CommonMark/GFM support. The distinction between advertised Markdown bytes, those standard semantics, and this parser's tested behavior remains explicit.

No substantive language/policy fork was chosen; this is a reversible downstream representation correction. No JEV call, installation, production/doc update or Git mutation was performed.
