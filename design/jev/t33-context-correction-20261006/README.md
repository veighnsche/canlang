# T33 corrected-context consultation

Codex-owned bounded research, 2026-10-06. This corrects material context omitted from the earlier Muse-owned consultation; it does not replace its historical evidence or claim runtime implementation. The description/reference consultations are unrelated and were not repeated.

## Reason for correction

[OBSERVED] The primary `.can` files separate committed source events and four `each=` child handlers from explicit bounded inline loops: Shift:226-248, Volunteer:47-52 and :173-185. Supporting `CanShift.md:81` says the old rejecting 500-row sweep bound is gone, admitted 499/500/501/1000 identities share the complete contract, and failed children do not stop siblings. `CanVolunteer.md:73` separates parent cancellation/durable-trigger success from later children and requires remaining/failed progress. The existing fanout prep :478-535 already quoted and analyzed this evidence. The consultation state omitted it, and bounded_atomic criteria said atomic-versus-per-child outcomes were unpinned.

[OBSERVED] These companion requirements precede this implementation run in draft commit `3c9b544` (2026-10-04); current draft pin is `2d67312`. Their direct human authorship was not independently certified; they are supporting intent, not executable proof or authority overriding contradictory `.can` source. Two independent read-only reviewers corroborated the omission and reconstructed the primary site intent.

Corrections: B rejects overflow visibly, so “wrong B fails silently” is not a fair characterization. An atomic handler after source-event commit can preserve immediate parent cancellation; its remaining mismatch is child failure isolation/progress and a new sweep capacity bound. A is finite and has resource costs; bounded execution chunks are different from a semantic cohort-count cap. D is not proved impossible: the sole-roster invariant permits conceivable authoritative lookup/remodeling, but no equally faithful coverage design is supplied. Not being any response's first choice does not establish unanimous rejection of C or D.

## Equivalent requests and observed results

All three requests have byte-identical verified state/options and independently worded equivalent questions. Each compares the same workflow fidelity, negative controls, safety, implementability, authoring economy, migration and total proof/maintenance cost. No risk/preservation/economy weighting switch was used. Payloads contain bounded nonsecret design summaries, not complete sources or credentials. The existing repository caller used its configured credential without displaying/saving it.

| Call | Choice | Confidence | A | B | C | D | Input/output tokens |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | durable_checkpointed | .88 | .92 | .01 | .06 | .01 | 1553 / 65 |
| 2 | durable_checkpointed | .93 | .95 | .00 | .04 | .01 | 1554 / 65 |
| 3 | durable_checkpointed | .97 | .99 | .00 | .01 | .00 | 1552 / 65 |

[OBSERVED] Each `python3 tools/jev.py design/jev/t33-context-correction-20261006/request-N.json --output design/jev/t33-context-correction-20261006/result-N.json` exited0 on its first request to `https://api.typesafe.ai/v1/systemone`, model `jev-1.13.0`. Exact request/response records are retained. Aggregate usage4659 input/195 output tokens. No retry, approval rejection or alternate ingress was used. Independent local JSON validation confirmed identical state/options and three distinct question paraphrases.

## Interpretation and uncertainty

Strongest opposing case: companions may reflect a prior agent's proposed intent, small fixtures demonstrate no production population, and durable enumeration/checkpointing introduces substantial failure modes. B can be the cheaper correct design if the adopted product intentionally changes to capped whole-handler atomicity; D or C could prevail with equally complete lower-cost authoritative remodeling/continuations. The primary draft distinction and pre-run explicit companion behavior nevertheless support independent child semantics better than a new atomic-sweep cap.

[INFERRED] Recommend A from corrected draft evidence and implementation tradeoffs; JEV advice corroborates this reasoning. The stronger responses after context correction are evidence of input sensitivity, not proof the omission alone caused every probability shift. The service returns no rationale. No new product population estimate is required merely to preserve the recorded contract. Confidence high for A versus the stated B; medium for unpinned membership/concurrent-change/supersession defaults until their exact T34 implementation is proved. An adopted revised contract requiring capped atomic handlers, or a demonstrated equally complete lower-cost continuation design, would change the choice.

The bounded decision and T34 proof obligations are in `implementation/challenge-audit-run/t33-resolution.md`. No active saved plan, existing Muse evidence/checklist or implementation source was edited by Codex. Relevant writers must release before future overlapping contract/plan changes; current T25a work-contract ownership remains intact.
