# T33 JEV gate — MIXED advice, no consensus (item 9 recorded, gate NOT closed)

Model: jev-1.13.0. Three consultations, same byte-identical state + criteria
(fact-equivalence by construction — only `instructions` differ), framings
risk / preservation / economy. Requests: request-1/2/3.json. Results:
result-1/2/3.json. No provider flakes; all three landed first try.

## Results (choice + confidence + full distribution)

- R1 (risk framing): durable_checkpointed, conf .27 —
  A .46 / D .28 / C .13 / B .13.
- R2 (preservation framing): bounded_atomic, conf .19 —
  B .39 / A .31 / D .16 / C .14.
- R3 (economy framing): durable_checkpointed, conf .20 —
  A .40 / D .28 / B .24 / C .08.

Plurality 2/3 for A; mean probabilities A .39 / B .25 / D .24 / C .12.
Confidences are VERY soft (.27/.19/.20) and the winner is
framing-dependent (preservation alone prefers B, by .08 over A).
NO unanimous mandate. This file claims no consensus.

## Disagreement investigation

- R2-vs-rest: the preservation framing weights verbatim workflow
  preservation + minimal intervention highest. B preserves all four
  sites with zero draft edits IF cohorts fit the cap — and the only
  measured cohorts are <=2 records (item 6), so B's condition looks
  satisfiable on current evidence. A pays machinery for durability no
  evidenced cohort needs. Hence B .39 > A .31.
- R1 (risk): weights silent incompleteness + lost crash work highest.
  B's cap/transaction hazard scores its LOWEST anywhere (.13); C's
  silent misses score .13; A is the only option that cannot silently
  cut. Hence A .46, decisive on the audit's own fear ordering.
- R3 (economy): counts TOTAL cost (implementation + T34 proof +
  migration + re-proof + future repetition). B's cheap adoption loses
  to cap-stranding re-proof risk; C repeats migration forever; A's
  one-time machinery wins on total. Hence A .40.
- The crux both framings agree on: B iff Shift cohorts fit a
  defensible cap, permanently. Dev-scale evidence (<=2) cannot settle
  production cohort sizes; crash-durability need is likewise a product
  judgment (sweep criticality). The classifier's softness is honest:
  the packet's technical facts underdetermine a product judgment.

## Firm findings (unanimous across framings)

1. C (no_primitive) RULED OUT: .13/.14/.08 in every framing — the only
   option all three agree to reject. The R19 flip burden (EQUAL
   completeness/recovery, not fewer features) is unmet.
2. D is nobody's first choice (.28/.16/.28) and item 7 stands: no
   single anchor covers all five EligibilityReview emitters, so any
   anchored reading strands Shift sites 1-2 unless emitters remodel.
3. Anchored cohorts (Volunteer site 4 shape) are the least contested
   adoptable unit: D's machinery is A's, and site 4 checks unchanged
   under A too.

## Coordinator recommendation (advice, NOT a gate ruling)

Adopt A (durable_checkpointed), scope C out, record B's cap-condition
as the decision's crux. Reasons: (a) plurality + mean + 2/3 framings;
(b) the risk framing — the audit's own lens — is decisive for A
(.46 vs B .13); (c) wrong-A is recoverable (working but expensive
machinery) while wrong-B fails silently at scale (the audit's core
fear); (d) D strands the flagship workflow per item 7. The dissent is
real and preserved: if Shift cohorts are quotad small forever, B was
the cheaper correct answer — that quota is a product decision no
evidence here can supply.

## Bounded question for Codex/product (gate held open)

T33 stays OPEN. Adopt-vs-scope needs ONE product judgment: are Shift
whole-model sweep cohorts quotad small (cap + overflow diagnostic
acceptable, possibly forever) or must the contract cover unbounded
whole-model enumeration with crash recovery? The first sustains B; the
second requires A. C is out; D needs the emitter-remodeling answer
(item 7) before it can serve Shift. Item 10 (T34 proof plan) and T34
implementation hold until adoption — no T34 work begins per the prep
file's gate rule. No active writer is affected (T18/T32b-cf disjoint);
independent work continues.

## CORRECTION NOTE (2026-10-06, Codex supervision — this section supersedes the mixed verdict above; nothing above was edited or deleted)

The packet behind the R1/R2/R3 calls above omitted material existing
intent and is superseded. Coordinator-owned errors:

1. The state + B criterion said "nothing in the drafts pins atomic
   vs per-child outcomes." FALSE: Shift.md:81 (old 500-row sweep
   rejection gone; one terminal outcome per admitted identity;
   current child evaluation; sibling failure isolation) and
   Volunteer.md:73 (parent durable-trigger success before children
   finish; remaining/failed progress) pin per-child semantics — and
   the prep file this coordinator verified (fanout-decision.md:478-535)
   already quoted them. The JEV state failed to carry them.
2. "Wrong B fails silently" framing was tendentious: B rejects
   overflow visibly (honest). B's real mismatch is child failure
   isolation/progress + a new sweep capacity bound.
3. "C ruled out unanimously" overclaimed: low probabilities across
   three calls are not a rejection. C/D are ruled out by the
   resolution on draft-outcome grounds, not by vote-counting. D was
   never proved impossible (sole-roster remodeling conceivable but
   unsupplied and unfaithful as analyzed).

Resolution: ADOPT A (durable per-child fanout) for both each= forms —
see Codex-owned `implementation/challenge-audit-run/t33-resolution.md`
(first contract + Item-10/T34 matrix) and
`design/jev/t33-context-correction-20261006/` (3 fresh corrected
consultations: A .92/.95/.99, conf .88/.93/.97, no retries — advice
corroborating the draft-grounded recommendation). No further JEV for
this question unless new material uncertainty arises. T33 ticked on
adoption + proof-plan record; T34 implementation/proof pending.
