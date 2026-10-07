# OUT-R03 Markdown implementation

Status: implemented and frozen for independent review; no merge or publication.

Released paths are exclusively `packages/interfaces/src/docs/reference.ts` and `packages/interfaces/test/docs-reference.test.ts`; both were clean before work. Exact diff and SHA-256 pins are saved alongside this report. Research files remain unchanged.

The code span helper now selects a delimiter longer than every authored backtick run, preserves literal backslashes, and pads edge backticks or paired edge spaces according to CommonMark. The maximum-run scan avoids spreading a potentially large array. Empty values and pipe-bearing table values use inline code HTML with punctuation encoded as numeric entities; the two table call sites pass table context for their name, type and default cells. Prose, constraints, anchors, localized text, source offsets and example fences retain their owning behavior.

Nine public-renderer byte-contract regression examples cover mixed and 64-character backtick runs, paired edge spaces, all spaces, empty values, literal backslashes, odd backslash/pipe runs and HTML-looking values in both declaration and operation name/type/default cells. The saved external parser replay independently checks text and seven-column shape for the broader 28-case matrix.

Verification (existing genuine Node v24.21.0, Bun 1.4.2 and task runtime):

- `node scripts/run-tasks.mjs build --filter=@canlang/interfaces`: 10/10 tasks successful, fresh owner compilation; permitted TypeScript dependency DAG compilation.
- `node --test packages/interfaces/dist/test/docs-reference.test.js`: 58/58 passing (49 existing plus nine regressions).
- `node scripts/run-tasks.mjs typecheck:check --filter=@canlang/interfaces`: 11/11 tasks successful, owner no-emit check executed.
- `node implementation/compiler-completion/markdown-owner/implementation/replay.mjs`: actual public renderer 28/28, historical candidate algorithm comparison 28/28, marked 17.0.5 GFM then happy-dom. Preserves fenced example text and authored descriptions.
- Focused `git diff --check`: passes.

Replay writes only the implementation folder. Its `baseline` observation field means the current actual public renderer, not the historical failing baseline. The immutable research `raw.json` retains historical 8/28 versus candidate 28/28 evidence; the implementation summary explicitly names `actualPublicExact`. Candidate comparison is historical proposal behavior, not a separate shipped API.

Scope remains single-line exact DOM code text and table shape under this consumer. No new dependencies, viewer policy, CLI/API, compiler, package manifest, source-to-CLI claims or raw multiline preservation were introduced. Existing inline HTML support is required for the qualified fallback. All checks have full logs in this folder.
