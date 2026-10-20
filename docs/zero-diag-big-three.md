# The big three (path from 107 to ~60 diags)

These are the three redesigns behind roughly 50 of the remaining 107
diagnostics. Each is refused today for a soundness reason, not a missing
line of code. Small fixes cannot clear them; each needs its own design.

## 1. Searches inside rules (~30 diags)

Many rules use searches like `all(...)`, `any(...)`, or `count(...)` in
their `require` lines — for example "all portions have an allowance" or the
`can_work` permission check, whose body itself runs a search. The compiler
cannot currently prove a search that lives inside a rule, so it declines the
whole scenario.

A redesign must answer: how does the emitted rule capture the search, what
do empty results mean, and how are nulls handled — without letting an
unproven search silently pass.

## 2. Event handlers that send or create (~17 diags)

Handlers that react to events (`on=...`) and then send mail or create
records are only accepted in one narrow shape today (one saved value plus
one check, plus a first search). All 17 failing handlers do more than that,
so they are declined at the door.

A redesign must answer: how does the sealed receipt vouch for sends and
creates that depend on event data the app did not author (mailbox input,
schedule payloads) — without trusting outside data blindly.

## 3. Data flowing across two models (~20 diags)

Scenarios that search one model, then create and return a different model
are refused because the compiler cannot trace the handoff between the two.
The current proof only covers single-model cases, deliberately.

A redesign must answer: how to split the proof so each model's part is
sealed separately and the joined result stays reproducible — without
blurring which model vouches for which field.

## Deliberately out of scope

The `!=` (not-equal) grammar stays refused: "not equal" cannot be sealed
the way equality can, and no failing site clears from it alone.
