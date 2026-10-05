# T32a authoritative-read consultation (coordinator-run gate)

Challenge-audit T32a evidence: final gate input (coordinator-run JEV).
Full alternatives, fairness record and gate evidence:
[read-decision.md](../read-decision.md).
No source file contents, business records, credentials or authorization
headers are present in the request files.

## Alternatives (equivalent in all three requests)

- **checkpoint_fence (A)**: every state-dependent read runs at one owner
  checkpoint in the settled revision fence; commit re-asserts the
  checkpoint and revalidates permission + revocation against live
  authority state, failing closed on any intervening change.
  Transitive effects open fresh checkpoints. Cost: enrollment plus
  commit-time revalidation per guarded operation; contention raises
  conflict rates; database-wide assertion couples unrelated operations
  to revocation bookkeeping.
- **read_at_effect (B)**: no predicate result crosses guard into effect;
  each effect re-reads live authorization and state at claim time.
  Cost: per-effect authorization reads; let-bind-guard-act sites need
  a live-or-captured ruling or per-site rewrites; fence stays anyway
  for write-write conflicts; authors may smuggle carried values via
  `let`.
- **pinned_snapshots (C)**: reads pin observed versions + checkpoint;
  commit proceeds iff pins hold; declared-eventual reads pin nothing
  and can never authorize or spend. Cost: pin machinery; a second read
  kind to specify and teach; narrowed-assertion D1 proof owed (or
  collapse into A with stranded bookkeeping); recurring
  authorizing-versus-eventual adjudication.
- **bounded_grants (D)**: authorizing reads mint expiring grants over
  targets/versions/outcomes/checkpoints; commits validate against
  fence plus revocation list; spends need dispatch-fresh grants.
  Cost: largest surface (lifecycle, retention, expiry, diagnostics,
  projection); per-commit revocation consults; no sampled workflow
  needs portable grant evidence.

Observed facts held equivalent: 473 pure-position lines in 50 files;
288 spend effects (236 sends, 69 targets, 22 money-creates, 27
allowance-sets); live revocation immediacy (Grant deactivate-then-deny);
settled D1 database-wide fence with admission evaluation, commit-time
permission recheck, atomic dispatch guard-plus-claim, mandate-checked
collect, reread-marked display reads; six workflows (Chat spend,
can_use, Creative guard, Check heartbeat); T06 narrowing, T16/T17a
plus verified T17b, T28-A same-owner fencing, T31a flat staging;
T29 atomicity owed; zero intra-operation gap executions (9 candidates,
31 conflict rows, no active_member or let observations); R29 alias
flip open with T23/T22/T21 pending; fence plan-not-proof with memory
limits and DECISIONS #138 open; active_member barred without a
bounded-read contract; no T24 dispatch record; D1 contention leading
runtime uncertainty. Framing varies by request (1: risk-first,
2: preservation-first, 3: economy-first); option keys and the choice
question stay stable. Lexical fact-equivalence verified (token census
across all three states before running; one workflow-name patch to
request-1).

## Commands and outcomes

```sh
python3 tools/jev.py implementation/challenge-audit-run/evidence/jev-t32a-20261005/request-1.json --output implementation/challenge-audit-run/evidence/jev-t32a-20261005/result-1.json
python3 tools/jev.py implementation/challenge-audit-run/evidence/jev-t32a-20261005/request-2.json --output implementation/challenge-audit-run/evidence/jev-t32a-20261005/result-2.json
python3 tools/jev.py implementation/challenge-audit-run/evidence/jev-t32a-20261005/request-3.json --output implementation/challenge-audit-run/evidence/jev-t32a-20261005/result-3.json
```

jev-1.13.0, 1596/1492/1305 input tokens, 60 output tokens each.
Provider flakiness: request-1 failed once (HTTP 529) then landed on
retry; request-2 failed three times (HTTP 503 x3) then landed on the
fourth attempt after backoff; request-3 landed first try. No request
content changed across retries. UNANIMOUS ADOPT checkpoint_fence (A):
R1 .65 (confidence .53), R2 .80 (conf .73), R3 .76 (conf .67).
Runner-up is framing-dependent: read_at_effect draws .22 under the
safety framing (R1), pinned_snapshots draws .15/.18 under preservation
and economy framings (R2/R3); bounded_grants ≤.02 throughout. Stable
winner, unstable margins and soft confidence — the record of
investigator disagreement: B's gap-elimination resonates most when
safety leads, while A wins every framing on workflow preservation
plus minimal new surface.

## Disposition

T32a ADOPTS Alternative A (checkpoint_fence): one owner checkpoint
per operation in the settled fence, commit-time revalidation of
permission + revocation, closed read→effect gap, fresh checkpoints
for transitive effects. Standing obligations carried into T32b:
L291 "already admitted may finish" scope (authority revoked between
admission and commit vs racing an already-fenced batch); whether the
database-wide fence is an acceptable revocation boundary or a
narrower per-team/per-record fence is required; DECISIONS recording
left for Codex review. JEV is advice to this gate, not an
implementation result.
