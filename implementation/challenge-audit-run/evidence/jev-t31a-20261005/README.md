# T31a secondary-hook consultation (coordinator-run gate)

Challenge-audit T31a evidence: final gate input (coordinator-run JEV).
Full alternatives, fairness record and gate evidence:
[hook-decision.md](../hook-decision.md).
No source file contents, business records, credentials or authorization
headers are present in the request files.

## Alternatives (equivalent in all three requests)

- **staged_flat (A)**: hooks adjust the pending record and stage
  secondaries (other-row writes, timers) committing atomically with the
  trigger in one owner transaction; invariants re-run, versions reserved,
  staged targets fenced, flat evaluation, no hook reentry. Cost: larger
  transactions in the bounded-work budget, failure coupling (a broad
  staged write fails the trigger far from its cause), cross-line
  attribution, engine atomicity proof still owed.
- **committed_handlers (B)**: hooks keep only adjust-or-reject; all
  secondaries move to committed-event handlers in later transactions.
  Cost: all 36 secondary-effect bodies remodeled with per-site re-proof,
  trigger+children atomicity surrendered (partial success possible),
  completeness leans on retry/recovery with no dispatch evidence, one
  workflow read in two places, staged draft intent discarded.
- **declared_allowlist (C)**: A-like staging only to contract-declared
  targets (children parented to event.after, pending-bound timers);
  everything else reroutes to handlers. Cost: new declaration surface,
  recurring boundary disputes, dual mechanisms, a syntactic proxy for
  blast radius that invites re-parenting games and may accrete toward A.
- **bounded_cascade (D)**: as A, except staged writes to other models
  re-run those models' hooks (static cycle rejection + runtime depth
  bound); triggering path stays closed. Cost: widest specified surface
  (order, bound, interaction, attribution, interleavings, cascade-wide
  proof), spooky cross-package recruitment into the user's transaction,
  no sampled workflow needing it.

Observed facts held equivalent: 44 CRUD hooks in 16 files (20/23/1),
36 with secondary effects (17 parented, 10 timers, 8 cross-row, 7 other,
zero deletes), 8 settled-only; DESIGN settled core (pre-commit,
adjust-or-reject, no new params, no triggering callbacks, one
hook/model/op, cycle errors, v1 creation rows, v+1 reservations, no
parent advancement); five CanCheck workflows (pending adjustment with
v/v+1 fencing, parented Transition/Notice, Deadline timer,
conflict-on-change, all-or-nothing commit plus hook negatives); T30
landed; R27 update/hook split with T18 offering no rule; T28-A adopted
with T29 atomicity + split diagnostic owed; T16 + state-side T17a done
with durable evidence plan-not-proof and restarts unclaimed; T23 one
discriminating + one control input, zero of 26 blocks on hook
scenarios, R29 open; R17 secrets residual. Framing varies by request
(1: preservation-first, 2: risk-first, 3: economy-first); option keys
and the choice question stay stable. Lexical fact-equivalence verified
(token census across all three states before running).

## Commands and outcomes

```sh
python3 tools/jev.py implementation/challenge-audit-run/evidence/jev-t31a-20261005/request-1.json --output implementation/challenge-audit-run/evidence/jev-t31a-20261005/result-1.json
python3 tools/jev.py implementation/challenge-audit-run/evidence/jev-t31a-20261005/request-2.json --output implementation/challenge-audit-run/evidence/jev-t31a-20261005/result-2.json
python3 tools/jev.py implementation/challenge-audit-run/evidence/jev-t31a-20261005/request-3.json --output implementation/challenge-audit-run/evidence/jev-t31a-20261005/result-3.json
```

All three exit 0, jev-1.13.0, 1571/1523/1389 input tokens, 59 output
tokens each. UNANIMOUS ADOPT staged_flat (A): R1 .98 (confidence .96),
R2 .94 (conf .92), R3 .96 (conf .94). Runner-up declared_allowlist
.02/.05/.03; committed_handlers .00/.01/.01; bounded_cascade 0.0 in
all three — the cascade's unrequested surface convinced no framing.

## Disposition

T31a ADOPTS Alternative A (staged_flat): hooks stage flat,
same-transaction secondary writes with no hook reentry. Standing
obligations carried into T31 implementation: same-model-via-different-op
baring question; R27/server-owned rule (needs adopted T18 or
re-anchor mechanism); staged-write fan-out bounds; trigger+children
atomicity as intent-vs-convenience; engine atomicity proof for staged
sets; DECISIONS recording left for Codex review. JEV is advice to this
gate, not an implementation result.
