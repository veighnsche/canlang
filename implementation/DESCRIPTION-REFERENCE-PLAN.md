# Shared descriptions and generated internal reference

Status: Codex-owned implementation design/checklist; user has explicitly prioritized implementation now. This is an addition requested by the user after the 41-task challenge plan; the prior queue-only handoff was acknowledged in the same Muse TUI. Its blanket wait is superseded by the latest user instruction. Current original writer reservations remain intact; a concrete start handoff is being delivered and actual startup evidence belongs in the authoritative monitor. All three required JEV calls completed after explicit user authorization to resend; advice is mixed and recorded below. No implementation is claimed.

## User requirements and scope

The user proposed `name:text desc="Source"@{nl="Translation"}` instead of putting a description and a locale beside each other inside a general annotation. The user then requested an automatic documentation writer so description translations have a useful audience, or removal of description translations if they have no value. The confirmed first audience is **internal developers and integrators**.

Deliver a deterministic internal reference generated from owning declarations and their authored descriptions. Give optional description translations an actual reference-documentation consumer. Keep meaningful source descriptions for MCP and IDE use. Do not impose a translation quota or add descriptions that merely repeat types/names. Existing UI text localization remains independent of this decision.

The first delivery includes the proposed inline field/parameter spelling, one internal description representation, localized internal Markdown and consistent source-language IDE help. Existing MCP source-string output remains compatible. Localized MCP and artifact migration are explicitly deferred follow-up, so they cannot block the requested reference. This scope excludes AI-written guides, automatic translation, public hosting, end-user tutorials, new business effects, a new permissions model, and rewriting the 49 drafts. Public documentation needs its own requested audience and publication decision.

## Verified evidence

- [OBSERVED] IDE symbol hover reads attached declaration prose, including scenario descriptions: [queries.rs:810](/Users/vince/Projects/canlang/compiler/src/ide/queries.rs:810). The current display helper returns source prose and displays shared references as `see path`, without selecting a translation: [queries.rs:1207](/Users/vince/Projects/canlang/compiler/src/ide/queries.rs:1207).
- [OBSERVED] Scenario IR retains a message description, but published operation metadata takes `message.source`: [js.rs:3348](/Users/vince/Projects/canlang/compiler/src/codegen/js.rs:3348). MCP descriptors presently have plain-string descriptions: [ports.ts:163](/Users/vince/Projects/canlang/packages/interfaces/src/ports.ts:163), [ports.ts:193](/Users/vince/Projects/canlang/packages/interfaces/src/ports.ts:193).
- [OBSERVED] Field/parameter annotations accept only a literal `desc` key, rejecting locale keys. Bare `desc=` is rejected as an unsupported field modifier: [parser.rs:1940](/Users/vince/Projects/canlang/compiler/src/syntax/parser.rs:1940), [parser.rs:2619](/Users/vince/Projects/canlang/compiler/src/syntax/parser.rs:2619). Field/parameter descriptions are `Option<String>` in IR: [ir.rs:255](/Users/vince/Projects/canlang/compiler/src/codegen/ir.rs:255).
- [OBSERVED] The parser already handles static captions with a message suffix: [parser.rs:2028](/Users/vince/Projects/canlang/compiler/src/syntax/parser.rs:2028). Message IR and a locale formatter already exist: [ir.rs:1274](/Users/vince/Projects/canlang/compiler/src/codegen/ir.rs:1274), [locale.ts:152](/Users/vince/Projects/canlang/packages/values/src/locale.ts:152).
- [OBSERVED] Page descriptions have a real browser consumer: [shell.ts:215](/Users/vince/Projects/canlang/packages/ui/src/shell.ts:215) resolves them for HTML metadata. Removing every translation in the language would discard working UI behavior beyond the user's concern.
- [OBSERVED] The inspected CLI command inventory has no documentation generator: [cli.rs:1](/Users/vince/Projects/canlang/compiler/src/cli.rs:1). The current design specifies one description shared by browser/MCP and optional localized prose: [DESIGN.md:881](/Users/vince/Projects/canlang/DESIGN.md:881). These intended semantics do not prove every consumer is implemented.
- [INFERRED] Source descriptions already earn their place through IDE/MCP use. Scenario-description translations currently have no demonstrated localized consumer in the inspected runtime paths. A localized internal reference is useful when actual readers need it; a generator does not by itself justify translating every declaration.

## Alternatives and recommendation

**A — Source-language reference and descriptions.** Generate deterministic documentation, remove translation variants specifically from declaration descriptions, and keep actual UI localization. This has the lowest translation maintenance and simpler description metadata. Its strongest case is that an internal team may share one working language and gain no benefit from translated API explanations. Its cost is abandoning an existing authoring capability and serving other-language readers poorly if that need emerges.

**B — Shared descriptions, optional translations, deterministic reference.** Generate the same reference and let each description carry optional variants. Inline `desc=` and attached `#` describe the same declaration. Reference rendering explicitly selects a locale and applies the shared fallback. The same value reaches other description consumers without rewriting prose. This adds compiler/reference plumbing and tests, but avoids duplicate documentation sources. It is the recommendation after mixed consultation advice and independent review, with localized MCP deferred and writer release still required before implementation.

**C — AI-written documentation first.** A source-grounded writer can connect workflows and draft explanations/translations. Its strongest case is that a reference table alone does not teach how operations cooperate. It adds model cost, nondeterminism and factual review, and can invent business behavior. It is not needed for the requested first internal reference. Optional reviewed guides can be proposed later if reference users need them.

[INFERRED] Confidence is high that B is technically feasible, medium that translated prose will be worth maintaining across this project. Verified multilingual readership would strengthen B's value; consistently single-language readership and costly locale plumbing would strengthen A. No calendar estimate or full-compiler acceptance is inferred from source inspection.

## Description contract proposed for adoption

1. Keep `#` as the readable multiline description form. Add `desc=` as the compact field/parameter form. Both populate one logical description slot; `label=` remains a short caption and does not silently become documentation.
2. The initial `desc=` value is a source string with optional keyed variants, or an existing static zero-parameter message reference. Reuse source-owner identity and fallback semantics. No record queries, execution, implicit interpolation, or parameterized descriptions.
3. Reject duplicate descriptions on one declaration, whether written with `#`, `desc=`, or the legacy annotation. No silent precedence or concatenation.
4. Accept existing literal `@{desc="..."}` as a compatibility spelling of that same slot during this change. Locale keys inside that legacy flat annotation remain invalid. Do not bulk-rewrite drafts to establish support.
5. Preserve source text, owning source-language identity, variants, and source location in the checked description value and reference model. The reference consumes the complete value. Existing MCP deliberately renders source-language text in this first delivery; that boundary must be documented, never mistaken for localized output.
6. Optional translations create no global requirement to translate every description. An explicit strict-coverage mode would be separate requested scope. Preserve existing fallback and distinguish absent variants from empty text.
7. Description metadata affects documentation only. Stored values, stable declaration/operation identities, business types, schema constraints and authority stay derived from their existing owners.

Example of proposed syntax, not a passing current program:

```can
P {
 name:text desc="The name shown to customers."@{nl="De naam die klanten zien."},
 amount:int
}
```

## Frozen first-delivery representation and rendering boundary

Use one compiler-owned static description representation: `source:string`, `sourceLang:string`, `variants:ordered (tag,string|null) pairs`, and `location:{sourceId,start,end}`. Absence is an optional description; empty source/variant strings remain distinct from absence. Descriptions carry no runtime parameters. Resolve static message references under their owning source language before building this value. Adapt a legacy literal annotation as source text with no variants and the field/parameter owner language; do not mutate source.

The initial reference model v1 covers owners, models/contracts and fields, user operations with inputs/results, descriptions, source links and authored examples. It reads checked descriptions directly, independently of artifact transport or MCP locale support. Resolved constraints and creation metadata belong with field/input facts. Policies/guards/effects/routes are not a mandatory first-delivery inventory; include only located facts already available without creating a new semantic inference pass.

Choose a concrete reuse boundary: Rust analyzes source and produces the internal reference model; a TypeScript reference renderer selects static descriptions using `@canlang/values` `resolveVariant`, then writes Markdown. `can docs` uses the existing `can-platform` runtime locator/child-process boundary for this renderer after successful analysis; pass structured reference data through stdin, with fixed arguments and no shell evaluation. The standard platform runtime is required for this output, just as existing run/build commands use it; missing runtime/renderer produces a truthful tool error.

The renderer uses existing runtime canonical locale handling, explicit requested locale or app default, owning source language, null-variant omission and existing whole-message fallback. It does not implement a second Rust locale engine or parse raw description prose as parameterized ICU. Reuse static selection, not formatting that could reinterpret literal braces. Keep shared fixtures covering canonical aliases/case, regional fallback, absent/null/empty variants, app-default fallback and source-owner fallback. Add an explicit package dependency on the existing values producer where needed; no new external localization library is required.

## Reference output contract

The first output is Markdown for internal developers/integrators, with stable owner/declaration anchors. Proposed invocation, to be implemented and added to command help:

```sh
can docs app.can --locale=nl --out generated/reference.nl.md
```

Without `--out`, render Markdown to stdout. Without `--locale`, use the app default and existing source fallback. This is a new subcommand; the example is not currently executable. Keep global diagnostic `--format=json|text` separate from documentation format.

Use the compiler's existing analyzed sources, selected app and canonical ownership graph. Do not build a second language parser or scrape generated MCP JSON as the complete reference. Generate only after required source analysis succeeds; report diagnostics and produce no misleading successful reference on failure. The generator does not require running business handlers or qualifying the original draft apps.

For the first-delivery declaration set, output:

- Canonical owner/declaration identity and kind, authored description, and source location.
- Model/contract fields and operation inputs/results, their declared/resolved types, nullability, creation requiredness, defaults and value constraints. Preserve the distinction between creation metadata and value type.
- Source examples and expected results marked **authored example**. An execution status requires actual version-matched test evidence; reference generation never runs examples or invents passed status.
- Implementation availability only where a verified owner/catalog supplies it. Otherwise say **implementation status unknown**. Passing analysis does not prove an entire workflow executes.

Do not infer current caller permission from a printed policy expression. Optional additional declaration inventories must use located facts already provided by analysis; they do not enlarge first-delivery acceptance.

Select explanatory description variants through the existing static locale resolver. Keep names, types, field selectors, operation IDs and source expressions unchanged. Shared reference headings need one reusable locale catalog; source fallback is acceptable when a heading or description is untranslated. Do not generate translations or concatenate sentence fragments.

Output must be deterministic for the same source/catalog versions and locale. Include source/catalog/language version identity, avoiding wall-clock timestamps in the body. Escape Markdown/embedded HTML so authored prose cannot inject executable content. Keep source paths project-relative in portable output. Do not embed credentials, current records or fixture values from unrelated sources; this is a local internal reference, not a publication action.

## Consumer and compatibility boundaries

The reference renderer consumes the complete shared static description value. MCP continues emitting a **source-language string** in JSON Schema/tool descriptions in this delivery. New inline literal descriptions must reach that same existing source-string path, while localized reference output retains and uses the variants. No artifact migration or connection-locale feature is needed to qualify the reference.

A later localized MCP change would resolve a complete description value using the existing connection-preference/app-default contract, preserve schema identity, version affected metadata and adapt older plain strings. It remains explicitly deferred; do not claim it complete or add a business locale argument in this scope.

IDE hover displays inline `desc=` and attached `#` from the same description slot in the source language. Resolve static references to their wording. Localized hover and an editor locale setting are outside first delivery.

Browser form help is not part of this first version. Existing localized page metadata remains working and unchanged. Reusing shared description values later is possible but is not claimed as implemented behavior.

## Supplemental implementation checklist and ownership

The existing Muse coordinator remains the sole implementer/coordinator. Codex owns this design, JEV research and independent review. Muse writes progress in a new supplemental checklist only after acknowledging this scope; it does not edit the Codex monitor. Keep at most three active workers and one heavy check, reusing the existing checkout/cache. No new branch, worktree, coordinator or tmux session is needed.

The user clarified that this feature is to be implemented now. The earlier blanket wait for the entire 41-task challenge handoff/review is superseded. Current exact-file reservations remain intact; do not interrupt the active T30 writer. The coordinator has confirmed the supplement had no writers/reservations. Start disjoint D02a syntax and D04a/D05a contract-renderer slices in the two free slots, then prioritize D02b semantic integration at the next release of shared checker files. Freeze the reference-model contract before renderer/extractor consumers and serialize heavy checks. Codex does not edit the original active checklist or normative documents underneath current writers. Inspect and reuse the matching active native goal for this user steering, recording supplemental acceptance separately; never replace an unrelated active goal or mark unfinished original work complete. If the native goal schema permits scope amendment, use it truthfully; otherwise report the representation limitation without inventing a second coordinator. Independent review occurs after the relevant D-scope writers release; unrelated original tasks need not finish first. The heartbeat tracks both finite scopes and preserves viewer/cleanup ownership.

- [ ] **D01 — Complete design gate and controlled scope handoff**
  - Owner: Codex. Files: this plan and `design/jev/description-reference-20261005/*`; monitor follow-up only.
  - Prerequisites: three equivalent JEV responses recorded, disagreement investigated, material choices resolved, exact affected writer release and acknowledged same-session delivery before implementation.
  - Acceptance: frozen minimal reference/description/renderer contract; optional translations with no quota; localized MCP explicitly deferred; latest user-authorized scope/prioritization acknowledged in the same session, with per-slice compatible reservations rather than a blanket wait.
- [ ] **D02 — Add inline description parsing and checking**
  - Owner: one Muse Rust writer. Candidate exact paths: `compiler/src/syntax/{parser,cst}.rs`, `compiler/src/analysis/{resolve,types,effects}.rs`, focused parser/checker tests and required `tools/can_parser.py` grammar mirror. Reserve shared files before work.
  - Prerequisites: D01 and per-slice release. D02a parser/CST/new syntax tests may start while T30 owns checker files. D02b resolution/type/effects joins wait for those exact paths to release; parent D02 stays open until both are evidenced.
  - Acceptance: fields/parameters accept static inline descriptions and variants; defaults/bounds/labels delimit correctly; duplicate/dynamic/parameterized descriptions fail with located diagnostics; old annotations retain literal support.
- [ ] **D03 — Join compiler descriptions without artifact migration**
  - Owner: one Muse Rust writer; serialize shared analysis/IR/emission files.
  - Candidate paths: `compiler/src/analysis/effects.rs`, `compiler/src/codegen/{ir,js}.rs`, focused emission tests.
  - Prerequisites: D02 frozen static description value and writer release.
  - Acceptance: checked descriptions retain source/variants/owner language/location; inline/attached/shared descriptions feed the same value; existing MCP source-string output gets inline source text; undescribed/legacy artifact shapes remain compatible. Localized MCP and artifact-version changes stay deferred.
- [ ] **D04 — Derive the minimal source reference model**
  - Owner: Muse Rust documentation writer. Proposed new path: `compiler/src/docs.rs`, with module export and focused tests.
  - Prerequisites: D04a can freeze the versioned reference-model interface now in a new contracts/reference.ts and fixtures, using the already frozen static description fields. D04b Rust extraction waits for the D02 checked-description seam and exact path release; parent D04 stays open until the actual extractor is evidenced.
  - Acceptance: reference-model v1 contains owners/models/contracts/fields/user operations and authored examples with canonical links, resolved constraints and explicit unknown availability; no inferred authorization or invented execution results.
- [ ] **D05 — Render localized Markdown and expose the docs command**
  - Owner: disjoint Muse compiler/CLI and reference-renderer writers after model freeze.
  - Candidate paths: `compiler/src/{docs,cli,lib}.rs`, `packages/interfaces/src/docs/reference.ts` (new), `packages/cloudflare/src/cli/docs.ts` (new), `packages/cloudflare/src/cli/platform.ts`, relevant package exports/dependency and command help/completion files identified before reservation; focused CLI/reference tests.
  - Prerequisites: D05a renderer may start after D04a model-contract freeze, in the same worker if needed, independently of Rust extraction. D05b CLI/platform integration requires D04b extractor release plus renderer invocation agreement. Parent D05 stays open until the end-to-end command works; fixture-based renderer tests prove only that slice.
  - Acceptance: stdout/output-file modes; English/Dutch/canonical-alias/regional/app-default/source-owner/null/empty fallback cases via existing TS resolver; stable anchors/version identity; no misleading output on source/backend failure; escaped Markdown; no overwritten authored source files. No new locale engine or business execution.
- [ ] **D06 — Join source-language IDE help**
  - Owner: Muse IDE writer; reserve `compiler/src/ide/queries.rs` and focused hover tests.
  - Prerequisites: D02 frozen description slot and affected writer release.
  - Acceptance: inline, attached, legacy and static-reference descriptions display actual source wording; no editor locale feature or localized MCP acceptance gate.
- [ ] **D07 — Integrate and independently verify the reference**
  - Owner: Muse integration/handoff, then Codex independent review.
  - Prerequisites: D02-D06 released with actual evidence; zero writers/reservations/heavy commands before review.
  - Acceptance: `.can` source to English/Dutch/fallback reference and source-language IDE/MCP; legacy/undescribed MCP shapes preserved; retained negative controls; relevant suites and required checks pass. Localized MCP and authored-guide claims remain explicitly deferred.
- [ ] **D08 — Reconcile docs and close owned follow-up**
  - Owner: Muse normative/usage documentation after accepted behavior, then Codex cleanup/monitor closure.
  - Candidate paths: `DESIGN.md`, `GRAMMAR.md`, `DECISIONS.md`, relevant install/authoring documentation and CLI help. No broad corpus edits. Reconcile the living file-tree plan after any merge under AGENTS.md.
  - Acceptance: consistent syntax/consumer/value justification and exact limits; supplement native handoff complete only after evidence/release; preserve viewer/compact evidence; remove only released owned temporary resources; retire matching heartbeat after original and supplemental follow-up finish.

## Design gate and consultation status

The repository requires three independently worded equivalent JEV requests for difficult decisions. Saved requests preserve the same facts, constraints and options with separately worded explanatory passages. Structural validation succeeded.

- Request 1: after explicit user-authorized resend, `optional_shared`, confidence .31; B .54 / A .46 / C .00.
- Request 2: after explicit user-authorized resend, `source_only`, confidence .71; A .81 / B .19 / C .00.
- Request 3: original successful call, `optional_shared`, confidence .82; B .88 / A .12 / C .00.

These are self-reported judgments, not three-call consensus. Independent comparison found no material factual/criteria change sufficient to explain the reversal; wording changes alter emphasis and the responses provide no rationale. Treat the advice as unstable under equivalent paraphrases. The strongest competing case is a single-language reference audience with no translation need. All three gave AI-first zero probability within these stated alternatives.

The response to this uncertainty is a smaller first delivery: source-derived internal reference, optional use of existing authored translations, no translation quota or invented multilingual demand, shared static description value, and deferred localized MCP/artifact migration. This directly tests reference usefulness without making a broader localization project a prerequisite. The decision is Codex reasoning informed by advice, not a rationale returned by JEV.

Exact requests, responses, prior rejection reasons and resend authorization are preserved in [the consultation record](/Users/vince/Projects/canlang/design/jev/description-reference-20261005/README.md). All three calls are now complete; no external permission remains pending. The queue-only scope was acknowledged by the same coordinator with no D writers/reservations. The latest user clarification authorizes immediate compatible implementation slices and supersedes waiting for original H01/R01. Shared-file release, actual start acknowledgment and end-to-end acceptance remain recorded in the monitor/checklists.
