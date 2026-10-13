# T34-F8 fanout matrix proof (M1–M10)

Owner: session 01a13580 coordinator (goal-01a13581), per t34-plan.md §F8.
Each row names its witness tests, substrate, and the verification result
re-run in this session. All suites below re-ran green on builds from
current source (contracts + cloudflare rebuilt fresh; work/state rebuilt
fresh with no source edits since; compiler tests run on current source).

| Row | Requirement | Witnesses | Substrate | Session result |
| --- | --- | --- | --- | --- |
| M1 | 499/500/501/1000 one-outcome-each; inline-overflow rejection; chunk ≠ cohort | t34-f2 `M1 proof cohorts 499/500/501/1000` (memory + durable), `done:false` exact-multiple honest empty page, `§C9 chunk size is not cohort size`; t34-f3 `chunk size is not cohort size`; t34-f5 `freezes 1000 original members and refuses resource excess` | memory + D1/DO | F2/F3 74/74, F4/F5 137/137 |
| M2 | Real-restart resume at enum/claim/effect/checkpoint boundaries | t34-f4 durable restart suite; t34-f7-fanout-durable `T34-F7 fanout real restart (workerd DO)`; t34-f5 `resumes retained membership after interrupted admission`, `restarts one bounded retained admission prefix` | D1/DO + real workerd-DO restart | F7 durable 20/20 |
| M3 | Duplicate-delivery replay | t34-f3 `replays terminal outcomes/records, minting nothing`; t34-f2 `rejects a duplicate child row under the same full identity`; t34-f5 `duplicate child/attempt delivery replays without re-invoking` | memory + D1/DO | in F2/F3/F4/F5 totals |
| M4 | Insert/move/delete cutoff exactness | t34-f4 `moved records re-evaluate`, `demonstrably deleted pins skipped/deleted`, `rows outside the frozen set are phantoms`, `admits frozen members with no row — nothing else`; t34-f3 `records skipped/deleted` | memory + D1/DO | in F4/F5 totals |
| M5 | Revocation/rejection isolation + attention | t34-f3 `preserves refused-revoked/inherited-scope as failed`, `isolates revocation: revoked child fails while sibling proceeds`, `reports attention when terminal with failures`; t34-f5 `revocation between siblings voids ONLY the revoked child` | memory | in F3/F5 totals |
| M6 | Exhaustion attribution + fairness under stall | t34-f3 `exhausts on attempt cap / time horizon`, `retries transient within budget`, `fair under a stalled child`; t34-f4 `recorded attempts at the cap pin dead`, `default policy 8 attempts`, lifecycle-pins-win-over-exhaustion | memory + D1/DO | in F3/F4 totals |
| M7 | Two filtered occurrences retain coverage | t34-f4 `two occurrences plan independently: same record, separate fanouts, separate lists` | memory | in F4 total |
| M8 | Bounded-turn progress | t34-f3 `schedules pending only`, `pages pending children id-sorted with honest resume`, `fails closed on bad limits/cursors`; t34-f7 fair resumable scheduler + assembly serving surface (62 memory tests) | memory + assembly path | F3 in 74/74; F7 62/62 |
| M9 | Unchanged Shift/Volunteer workflows | F6 `f6_draft_bodies_accepted_without_trimming` (Shift commitment/swap + Volunteer refresh/cancel bodies, guards, notices, no trimming) + F5 admission proofs on both spellings; full app-level qualification rides downstream T40 (which gates on T34, so it cannot gate T34) | checker + admission | cargo F6 17/17 |
| M10 | Every negative control failing | F6 `f6_unsupported_forms/cross_owner/uncontained_child/unknown_model/unknown_collection_hop/anchored_misuse/undecoded_trigger diagnosed` + `f6_bounded_loop_rules_retained` (E1203-class behavior); F1 `fanout-records` closed-shape tests 18/18 | checker + contracts | cargo 17/17; vitest 18/18 |

## Totals re-run this session

- contracts F1 (vitest): 18/18; contracts tsc emit exit 0 (fresh).
- work F2+F3 (node --test dist): 74/74.
- work F4 + state F5 incl. work state-fanout mirrors: 137/137.
- compiler F6 (cargo effects f6_ 13/13 + codegen f6_ 4/4): 17/17.
- cloudflare F7 memory (fresh tsc build exit 0): 62/62; F7 durable incl. real workerd-DO restart: 20/20.
- work/state dists rebuilt fresh earlier this session with no source edits since; compiler tests run on current source.

## Standing remainders (do not block T34)

- Narrower revocation fence, active-member checker sharing, by-aware compound edge (T32 refinement class).
- Production call-site wiring for T25 receipt join (no barrel export).
- T28-A subtree-cascade ideal (pinned in B5/T29 evidence; no draft workflow exercises it).
- Full Shift/Volunteer app journeys qualify under T40, which consumes this T34 proof.
