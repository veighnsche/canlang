# Lane 05 C7 date-picker adapter decision and uncertainty

Date: 2026-10-04. Model `jev-1.13.0`; caller never retries.

## Question

Should C7 ship a visual month grid, and if so which pinned upstream
adapter DOM contract should the no-JS static markup follow?

- A: Pikaday-shaped static grid (`.pika-single` table, link/button days).
- B: vanilla-calendar-shaped static grid (`.vc` grid, link/button days).
- C: no server-rendered grid (native inputs + agenda sections stand).

Cally (custom-element script required to render) and React Day Picker
(React-coupled handlers) were excluded as unrunnable without their
scripts; the exclusion is verified against the pinned
`node_modules/daisyui/components/calendar.css`, which also shows a
fourth adapter (`.vc`) the catalog note omits.

## Results

Three fully rewritten equivalent choice requests (1-3):

| Request | Choice | Confidence | P(A) | P(B) | P(C) |
| --- | --- | --- | --- | --- | --- |
| 1 | B | 0.31 | 0.18 | 0.54 | 0.28 |
| 2 | C | 0.61 | 0.14 | 0.12 | 0.74 |
| 3 | C | 0.20 | 0.33 | 0.21 | 0.46 |

## Reading

Direction leans C (2/3) but every vote is weak-to-moderate and the
runners-up swing (C-then-A, A-then-B, A-then-B): material wording
sensitivity, not validation. Treated as advice. The deciding substance,
independent of the votes: a static grid must wire every day and nav
control to a working link or form post, which needs caller-supplied href
builders plus month/selection state — a large new contract for marginal
gain over the shipped, tested, fully working native date/datetime
inputs (field) and day-grouped agenda sections (collection).

## Decision

Adopt C: no server-rendered month grid in C7. The `calendar` word stays
native inputs (kind=field) plus agenda sections (kind=agenda). Rich
picker widgets stay app-owned; lane 05 emits no adapter-shaped markup.
Revisit only if L1 or drafts demonstrate a grid need the native
controls cannot serve. Catalog note updated to record this.
