# Lane 05 S5 interaction decisions and uncertainty

Date: 2026-10-04. Model `jev-1.13.0` via the `jev-latest` alias; caller never retries.

## Unsaved-state preservation mechanism

Three fully rewritten equivalent choice requests (1–3) compare:

- A: morph-by-default (innerMorph/outerMorph) on stable region ids; innerHTML only for explicit reset.
- B: innerHTML replacement with explicit preserve markers on every draft-bearing subtree.
- C: server-side draft echo with per-session per-page draft retention.

| Request | Choice | Confidence | P(A) | P(B) | P(C) |
| --- | --- | --- | --- | --- | --- |
| 1 | A | 0.58 | 0.72 | 0.05 | 0.23 |
| 2 | A | 0.87 | 0.92 | 0.08 | 0.00 |
| 3 | A | 0.51 | 0.67 | 0.23 | 0.10 |

Direction is unanimous but two of three confidences are weak, and the
runner-up swings between B and C across rewrites — material wording
sensitivity, not strong validation. Treat as advice: adopt A as the default
swap strategy for read-region rereads and mutation re-renders, with two
explicit countermeasures for morph's known failure modes:

1. Revoked values must disappear: regions re-render from current grants, so a
   revoked node is absent from new markup and the morph removes it. Tests
   assert removal, not just preservation.
2. Reset semantics (successful submit clearing a form, cancel discarding a
   draft) use explicit innerHTML/outerHTML swaps, never morph.

Server echo of submitted values on validation failure (S4) stays as the
failure path; it composes with morph because the echoed values are in the
new markup. No per-session server draft store is introduced (C rejected:
new retained state with its own revocation/expiry obligations).

## DOM harness pick (empirical, no JEV)

Harness selection was settled by measurement, not judgment: a probe under
`node --test` parsed identical markup in linkedom (2.5 MiB) and happy-dom
(17 MiB) and exercised query, focus/activeElement, keyboard dispatch, input
values, and innerHTML replacement. linkedom exposes `focus()` but leaves
`document.activeElement` undefined afterward, so focus-preservation and
focus-return tests — core S5 acceptance — cannot be verified under it.
happy-dom implements focus/activeElement, KeyboardEvent dispatch, and value
retention correctly. Decision: happy-dom as a devDependency of @canlang/ui
for interaction tests; linkedom disqualified on capability, jsdom not
evaluated (heavier fallback, unneeded). JEV was not consulted for this pick
because a required capability is observably absent; this note records the
deviation rationale.

## Fragment region identity (already settled)

DESIGN §9 with the prior fragment consultation
(design/jev/README.md §"Named fragments versus automatic partial responses")
keeps automatic inline regions for v1; no `fragment`/`render` declarations.
S5 implements region identity as stable server-generated ids on automatic
regions, not a new source syntax.
