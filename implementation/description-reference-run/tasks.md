# Description reference — Muse implementation checklist (supplemental run)

Status: user-authorized immediate implementation in the SAME existing Muse session (muse-spark-1.3-contributor MAX, `/Users/vince/Projects/canlang`, worktree off). Saved design: `implementation/DESCRIPTION-REFERENCE-PLAN.md` (Codex-owned; Alternative B). JEV evidence: `design/jev/description-reference-20261005/` (3 calls complete, mixed advice recorded — do not claim consensus, do not rerun).

- Scope: first delivery only — static inline/attached/shared descriptions, checked declaration reference (owners/models/contracts/fields/user operations/authored examples), localized internal Markdown via existing TS static locale resolver, consistent source-language IDE help, MCP source-string compatibility. Deferred (never claim): localized MCP, artifact migration, AI-written guides, auto-translation, end-user manuals, public publication, translation quota, broad draft rewrites.
- Ownership: Codex owns plan/JEV/monitor/independent review + D01/D07-review/D08-closure ticks. The ONE Muse coordinator owns this checklist (sole writer of progress), exact-path reservations, and all D writers. Coordinator-only Git (exact paths); no push/merge/PR before independent review.
- Native goal: reuse the matching active goal (`goal-01a10cc5-cd99-7ce2-9706-0d1eab1dec92`, session `01a106e7-49b5-7543-b54f-eb6ad9540769`); D acceptance recorded HERE separately — never fold D work into original percentages. Representation limitation: the native goal schema exposes no scope-amendment field, so the objective text still names the challenge checklist; both scopes are tracked via current_work + the two checklists.
- Load: max 3 active workers TOTAL across original + supplemental (T30 counts); ONE heavy build/test at a time; shared checkout/cache; no second coordinator/branch/worktree/cache. Native long-command initial yield 120000ms (60000-300000), routine reinspection 1-5min default 2 from last check, no empty polling. Preserve attached tmux viewer and foreign resources. Monitor is Codex-owned, read-only to Muse.
- Serialization: D02a + D04a/D05a run disjoint from T30-held checker files. D02b goes FIRST at T30 release, before any overlapping original checker dispatch. Freeze reference-model v1 before renderer/extractor consumers. Suffix slices release compatible consumers; parents stay open after partial slices.

- [ ] **D01 — Complete design gate and controlled scope handoff**
  - Owner: Codex (Muse does not tick). Files: `implementation/DESCRIPTION-REFERENCE-PLAN.md`, `design/jev/description-reference-20261005/*`.
  - Prerequisites: three equivalent JEV responses recorded, disagreement investigated, material choices resolved, same-session acknowledgment with zero D writers/reservations, latest user-authorized immediate start.
  - Acceptance: frozen minimal reference/description/renderer contract; optional translations with no quota; localized MCP explicitly deferred; per-slice compatible reservations rather than blanket wait.
  - Evidence: Codex-owned; Muse records only its start acknowledgment in progress below.

- [ ] **D02 — Add inline description parsing and checking**
  - Owner: one Muse Rust writer per slice (serialized). Candidate exact paths: `compiler/src/syntax/parser.rs`, `compiler/src/syntax/cst.rs`, `compiler/src/analysis/resolve.rs`, `compiler/src/analysis/types.rs`, `compiler/src/analysis/effects.rs`, `compiler/tests/b4_parse.rs`, `compiler/tests/b4_check.rs`, `compiler/tests/analysis.rs` (table values only), `tools/can_parser.py` (mirror only if required).
  - Prerequisites: D01. D02a (parser/CST/b4_parse tests + conditional py mirror) runs while T30 owns checker files. D02b (resolve/types/effects joins + b4_check tests + table with attribution) waits for T30 release and runs BEFORE the next overlapping original checker dispatch. Parent stays open until both evidenced.
  - Acceptance: fields/parameters accept static inline descriptions and variants; defaults/bounds/labels delimit correctly; duplicate/dynamic/parameterized descriptions fail with located diagnostics; old annotations retain literal support.
  - Evidence: D02a slice done (parent OPEN; D02b semantic join remains): writer 01a10d4a-9c23 released parser.rs (+138/-7, desc= via message-suffix reuse, attached-flag threading, all duplicate combinations located) + cst.rs (+8 DescriptionValue) + b4_parse.rs (+238, 16 tests: 5 pos + 11 rejection); can_parser.py untouched (mirror not required). Coordinator: b4_parse 20/0 green re-verified. Checker files untouched (T30 undisturbed).

- [ ] **D03 — Join compiler descriptions without artifact migration**
  - Owner: one Muse Rust writer; serialize shared analysis/IR/emission files. Exact paths: `compiler/src/analysis/effects.rs`, `compiler/src/codegen/ir.rs`, `compiler/src/codegen/js.rs`, `compiler/tests/codegen.rs`.
  - Prerequisites: D02 frozen static description value and writer release.
  - Acceptance: checked descriptions retain source/variants/owner language/location; inline/attached/shared descriptions feed the same value; existing MCP source-string output gets inline source text; undescribed/legacy artifact shapes remain compatible. Localized MCP and artifact-version changes stay deferred.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **D04 — Derive the minimal source reference model**
  - Owner: Muse reference-model writer (D04a, TS contract) + Muse Rust documentation writer (D04b, extractor). Exact paths D04a: NEW `packages/contracts/src/reference.ts`, `packages/contracts/src/index.ts` (export line only). Exact paths D04b: NEW `compiler/src/docs.rs`, `compiler/src/lib.rs` (module export only), NEW `compiler/tests/docs.rs`.
  - Prerequisites: D04a freezes versioned reference-model v1 now from already-frozen static description fields. D04b waits for the D02 checked-description seam and exact path release. Parent stays open until the actual extractor is evidenced.
  - Acceptance: reference-model v1 contains owners/models/contracts/fields/user operations and authored examples with canonical links, resolved constraints and explicit unknown availability; no inferred authorization or invented execution results.
  - Evidence: D04a slice done (parent OPEN; D04b extractor remains): writer 01a10d4a-9d6a released NEW contracts/reference.ts (160 lines, REFERENCE_MODEL_VERSION=1, JSON-safe, absence-distinct, no-auth/no-execution) + index export. Coordinator: contract read in full, matches plan; tsc 0.

- [ ] **D05 — Render localized Markdown and expose the docs command**
  - Owner: disjoint Muse renderer writer (D05a, same worker as D04a) + compiler/CLI writer (D05b). Exact paths D05a: NEW `packages/interfaces/src/docs/reference.ts`, `packages/interfaces/src/index.ts` (export line only), `packages/interfaces/package.json` (values dependency only), NEW `packages/interfaces/test/docs-reference.test.ts`. D05b candidates (identify before reservation): `compiler/src/docs.rs`, `compiler/src/cli.rs`, `compiler/src/lib.rs`, NEW `packages/cloudflare/src/cli/docs.ts`, `packages/cloudflare/src/cli/platform.ts`, command help/completion files.
  - Prerequisites: D05a starts after D04a model-contract freeze (same worker, sequential), independently of Rust extraction. D05b requires D04b extractor release plus renderer invocation agreement. Parent stays open until the end-to-end command works; fixture-based renderer tests prove only that slice.
  - Acceptance: stdout/output-file modes; English/Dutch/canonical-alias/regional/app-default/source-owner/null/empty fallback cases via existing TS resolver; stable anchors/version identity; no misleading output on source/backend failure; escaped Markdown; no overwritten authored source files. No new locale engine or business execution.
  - Evidence: D05a slice done (parent OPEN; D05b CLI remains): writer 01a10d4a-9d6a released NEW interfaces/docs/reference.ts (441 lines, resolveVariant-only, heading catalog en+nl, escaping, stable slugs) + index export + values dep + NEW test/docs-reference.test.ts (29 fixtures, every acceptance bullet). Coordinator: reuse boundary + fixtures reviewed, tsc 0; renderer 29/29 + suite 318/0 green re-verified, committed c9ca0db.

- [ ] **D06 — Join source-language IDE help**
  - Owner: Muse IDE writer. Exact paths: `compiler/src/ide/queries.rs` + focused hover tests (identify exact test file before reservation).
  - Prerequisites: D02 frozen description slot and affected writer release.
  - Acceptance: inline, attached, legacy and static-reference descriptions display actual source wording; no editor locale feature or localized MCP acceptance gate.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **D07 — Integrate and independently verify the reference**
  - Owner: Muse integration/handoff, then Codex independent review (Muse does not tick review/closure).
  - Prerequisites: D02-D06 released with actual evidence; zero writers/reservations/heavy commands before review.
  - Acceptance: `.can` source to English/Dutch/fallback reference and source-language IDE/MCP; legacy/undescribed MCP shapes preserved; retained negative controls; relevant suites and required checks pass. Localized MCP and authored-guide claims remain explicitly deferred.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **D08 — Reconcile docs and close owned follow-up**
  - Owner: Muse normative/usage documentation after accepted behavior, then Codex cleanup/monitor closure (Muse does not tick closure). Candidate paths (reserve under one reservation at dispatch): `DESIGN.md`, `GRAMMAR.md`, `DECISIONS.md`, relevant install/authoring documentation and CLI help. No broad corpus edits. Reconcile the living file-tree plan after any merge under AGENTS.md.
  - Prerequisites: D07 Muse integration evidenced.
  - Acceptance: consistent syntax/consumer/value justification and exact limits; supplement native handoff complete only after evidence/release; preserve viewer/compact evidence; remove only released owned temporary resources.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

## Progress (coordinator writes only)

- START: user superseded queue-only with immediate implementation start (same session/goal/checkout; T30 untouched). Checklist created from `implementation/DESCRIPTION-REFERENCE-PLAN.md`; D01 owned by Codex (unticked by Muse). JEV: 3 calls complete, mixed advice, no consensus claimed, no rerun.
- RESERVED batch D-a (2 writers + T30 = 3/3): D02a (parser.rs, cst.rs, tests/b4_parse.rs, tools/can_parser.py conditional — checker files EXCLUDED) + D04a/D05a (NEW contracts/reference.ts, contracts/index.ts export, NEW interfaces/docs/reference.ts, interfaces/index.ts export, interfaces/package.json values-dep, NEW interfaces/test/docs-reference.test.ts). Both disjoint from T30 (types/resolve/b4_check/analysis). Queued: D02b FIRST at T30 release (preempts T14a), then D03, D04b, D05b, D06, D07, D08.
- DONE D04a/D05a (static + tsc verified; runtime test run PENDING lock): writer 01a10d4a-9d6a-7970-9f4e-4c7c97822c6f RELEASED 3 new files + 3 one-line edits (exact scope). Contract v1 matches plan (absence-vs-empty, no auth/execution, version identity); renderer reuses resolveVariant only (no second engine); 29 fixtures cover every acceptance bullet. contracts+interfaces tsc 0 (coordinator re-verified). node --test run deferred — heavy lock held by T30/D02a cargo; commit follows the green run. Parents D04/D05 OPEN (see D04/D05 evidence).
- DONE D02a: writer 01a10d4a-9c23-7453-bde6-c6615aa49b1c RELEASED parser/cst/b4_parse (b4_parse 20/0 green re-verified). Parent D02 OPEN (see D02 evidence).
- GREEN D04a/D05a runtime: renderer 29/29 + interfaces suite 318/0 re-verified by coordinator after lock release. D04a/D05a committed with D02a (see D04/D05 evidence).
