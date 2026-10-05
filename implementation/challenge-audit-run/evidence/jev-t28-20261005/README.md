# T28 containment consultation (coordinator-run gate)

Challenge-audit T28 evidence item 6. Full alternatives, fairness record and
gate evidence: [containment-decision.md](../containment-decision.md).
No source file contents, business records, credentials or authorization
headers are present in the request files.

## Alternatives (equivalent in all three requests)

- **plain_import_containment (A)**: full local-containment semantics across
  plain imports; bound parents rejected. Cost: index-wide cycle/subtree
  engine work, cross-boundary diagnostics, unproven same-store atomicity,
  future-split exposure with no split-time diagnostic.
- **reference_scoping (B)**: required immutable parent reference + inheritance,
  no lifecycle cascade. Cost: two meanings of `in` by provenance, invented
  orphan rule with zero draft grounding, hand-built future cascades.
- **local_only_remodel (C)**: keep the rejection, remodel all 20 sites to
  explicit references. Cost: maximum authoring/review volume, per-site parity
  re-proof, discards stated relational intent for a checker limitation.
- **owner_consent_facet (D)**: containment only under owner-marked parents.
  Cost: new declaration form + versioning, three owner edits, consumers paced
  by owner releases, no trust boundary among same-project packages, no remote
  atomicity gain.

Observed facts held equivalent: 20/20 E2008 sites all plain-imported; 76-line
bound-import census with zero bound containment parents; cascade/orphan intent
absent 20/20 (4 near-misses, none dispositive); no facet mechanism exists and
owner willingness is unknowable from source; storage spec supports same-store
atomicity but engine expansion is unimplemented, generated commits use an
interim path, and no split diagnostic fires. Framing varies by request
(1: preservation-first, 2: risk-first, 3: economy-first); option keys and the
choice question stay stable.

## Commands and outcomes

```sh
python3 tools/jev.py implementation/challenge-audit-run/evidence/jev-t28-20261005/request-1.json --output implementation/challenge-audit-run/evidence/jev-t28-20261005/result-1.json
python3 tools/jev.py implementation/challenge-audit-run/evidence/jev-t28-20261005/request-2.json --output implementation/challenge-audit-run/evidence/jev-t28-20261005/result-2.json
python3 tools/jev.py implementation/challenge-audit-run/evidence/jev-t28-20261005/request-3.json --output implementation/challenge-audit-run/evidence/jev-t28-20261005/result-3.json
```

All three exit 0 via the repository caller (single attempt each, no retry).
Model jev-1.13.0 throughout. Total usage: 3505 input / 195 output tokens.

| Request | Choice | Confidence | Probabilities |
| --- | --- | --- | --- |
| 1 | plain_import_containment | .32 | A .49 / B .42 / D .06 / C .03 (1162 in / 65 out) |
| 2 | plain_import_containment | .36 | A .52 / B .41 / D .02 / C .05 (1150 in / 65 out) |
| 3 | plain_import_containment | .65 | A .74 / D .17 / B .08 / C .01 (1193 in / 65 out) |

## Advice, uncertainty and disagreement

The choice is unanimous (3/3 A), but the margins are unstable: requests 1-2
are near-ties between A and B (.49/.42, .52/.41) at low confidence (.32/.36),
while request 3 puts A at .74, collapses B to .08 and lifts D to .17. No
request gives C more than .05. The classifier returns no rationale, so the
swing cannot be assigned a demonstrated cause; the plausible salience story is
that the economy framing of request 3 punishes B's permanent two-meaning
maintenance cost and C's remodel volume while noticing D's bounded owner-edit
price — but that is a hypothesis, not a finding. Record: **stable winner (A),
unstable runner-up and margins**. Self-reported confidence is not measured
correctness. The strongest live opposing case remains B's: A couples
consumer-triggered cascades to owner-adjacent rows and its atomicity promise
rests on engine work explicitly still owed plus a split scenario with no
diagnostic.

## Gate outcome

ADOPT **Alternative A (plain_import_containment)** for T28: unanimous choice
across three independently worded equivalent requests, with C rejected
(≤.05 everywhere) and D at noise level in two of three. Standing obligations
carried forward, not waived: T29/T16/T17 must prove same-store atomic cross-
package subtree commits; a deployment-split diagnostic is owed; T29
implementation needs matching T15/T16/T17 facts still pending. Normative
recording (DECISIONS entry) is left for Codex review — no normative doc was
edited in this gate.
