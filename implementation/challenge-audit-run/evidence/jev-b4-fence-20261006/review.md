# B4 fence-scope consultation (coordinator-run JEV)

Challenge-audit B4 evidence: authority-contract input (coordinator-run JEV).
Settles the T32a parked remainder ("JEV-PENDING: whether the database-wide
fence is an acceptable revocation boundary or revocation needs a narrower,
per-team/per-record fence", read-decision.md). Full requests/responses are
adjacent (request-N.json, result-N.json). No source file contents, business
records, credentials or authorization headers are present in the request files.
Model: jev-1.13.0 for all three calls.

## Alternatives (equivalent in all three requests)

- **keep_wide**: the fenced commit keeps re-asserting the single
  database-wide settled revision unconditionally plus live permission and
  revocation revalidation; any intervening write voids the commit. The
  enrolled CheckpointDependency list stays attribution-only. Costs:
  authority-layer failure coupling (a membership-table write anywhere can
  void an unrelated in-flight operation), contention-driven conflict/retry
  growth, doubled predicate evaluation per mutation, D1 fence contention
  as the first unmeasured runtime uncertainty.
- **narrow**: the fenced commit voids only when an enrolled dependency
  moved (team membership rows, observed record versions). Costs:
  narrowed-assertion bookkeeping plus a D1 durability proof for the
  narrower scope, a second fence semantic to specify/gate/teach, and the
  risk that an unenrolled but authorizing read escapes invalidation.

## Responses and uncertainty

| Request | Choice | Confidence | P(narrow) | P(keep_wide) |
| --- | --- | --- | --- | --- |
| 1 | keep_wide | 0.13 | 0.43 | 0.57 |
| 2 | keep_wide | 0.74 | 0.13 | 0.87 |
| 3 | narrow | 0.03 | 0.52 | 0.48 |

Two of three prefer keep_wide, but this is wording sensitivity, not a
mandate: one strong keep_wide (0.74), one weak keep_wide (0.13), and one
flip to narrow at near-zero confidence (0.03 on a 0.52/0.48 split — a
coin flip, not evidence). No measured contention data exists behind any
answer; all three agree the safety property is currently carried by the
wide rule. Treated as advice per repository consultation rules.

## Decision

keep_wide STANDS as the B4 authority rule: the database-wide revision
assertion remains the revocation boundary; the narrower per-team/per-record
fence stays an explicit remainder, not a B4 implementation item. Grounds:
(1) the safety property (no mid-flight revocation silently authorizes a
commit or spend) is already proven by the wide rule; (2) no contention
measurements exist to justify new machinery plus new proof obligations;
(3) the JEV lean (2/3, including the only high-confidence answer) agrees,
and the single flip carries no weight. Revisit trigger (explicit): measured
D1 fence contention or retry rates from real pilot/app traffic (LG03 live
runs, LG05 qualifications) demonstrating that global coupling, not
correctness caution, dominates.

## B4 consequences (coordinator routing)

- Authority slice OPENS for B: implement the prescribed by-aware explicit
  check inside the mechanism (invoke.ts:124-130: the mechanism owns both
  `evaluateBy` and the live reader), with suite coverage driving compound
  gates through invoke (currently no suite exercises compounds there).
- Narrower-fence slice does NOT open: remains a named remainder with the
  revisit trigger above.
- Unchanged: hook-bounds value/rule waits for the fanout producer proposal
  (T34-plan Q5, routed to C at C2/C3); per-write receipt keying is a T04b/I00
  contract item; revocation/spend-race -> lane E follow-up, retry/recovery ->
  lane D follow-up.
