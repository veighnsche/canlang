# Disclosure flow-path enumeration — JEV consultation 2026-10-13

Status: advice recorded; direction A is a PROPOSAL, not an accepted decision or implementation.

## Verified context (measured on this tree)
- The scenario disclosure evaluator keeps one flow path per guard truth-case alternative; a 4-condition conjunction over a nullable first() result yields 64 alternatives for one incoming path; the 1024 paths-per-statement cap refuses creative.generate at the budget Require (source node 12097..12218 in draft/CanCreative.can), so generate and its caller from_turn cannot emit receipts.
- Experiments (all reverted): exact-duplicate path removal insufficient; same-environment merge with decision union changed working scenarios (E6008 8 -> 13); compatibility-gated merge restored 8 but did not unlock generate; joining one guard's alternatives into one successor path reproduced the 8 -> 13 breakage. Returned-value decision sets are taken from the whole path and are load-bearing.

## Consultation
Three independently worded equivalent requests (request-1..3.json) were sent via tools/jev.py (model jev-latest); raw responses in result-1..3.json.
- All three chose A: factor decision cases out of flow paths; paths carry environment and dependency accumulators; a returned value's decision set derives from the returned value's own provenance (its reads/decisions plus controls) instead of every decision evaluated on its path.
- Probabilities: A 0.48/0.51/0.44, B (dependency slicing) 0.29/0.29/0.33, C (symbolic lazy enumeration) 0.22/0.18/0.22, D (accept the boundary) 0.01/0.02/0.01.
- The accompanying noul ("can bound below the cap while keeping every working scenario's disclosure behavior identical") scored 0.46/0.32/0.38 — the identical-behavior claim is NOT established. Treat A as a redesign requiring its own corpus-validated implementation cycle, not a bounded patch.

## Current disposition
No evaluator change is accepted from this consultation alone. The 1024 cap, permissions, evaluation order and corruption refusals are retained; creative.generate, creative.from_turn and the event-hook first remain blocked at their recorded boundaries.
