# CanTime correction consultation

<a id="source-analysis"></a>

## analysis.md

### CanTime correction consultation

The three fresh requests preserve the same canonical CanTime signatures/guards, real invoice BillingV1 operations and cumulative Settlement fields, period-review and overlap requirements, one D1 owner boundary, and full replacement versus delta adjustment alternatives. Every explanatory paragraph, instruction and criterion was rewritten; technical identifiers remain exact. The initial sandbox call failed before receiving a response; the standing-authorized network call and the two remaining consultations completed, without exposing credentials.

| Request | Choice | Confidence | A probability | B probability |
| --- | --- | --- | --- | --- |
| [1](request-1.json) / [response](result-1.json) | B | 0.35 | 0.32 | 0.68 |
| [2](request-2.json) / [response](result-2.json) | A | 0.44 | 0.72 | 0.28 |
| [3](request-3.json) / [response](result-3.json) | A | 0.64 | 0.82 | 0.18 |

This disagreement prevents describing the consultation as independent agreement or proof. Inspection of `draft/CanInvoice.can` confirmed that cancellation permanently fences the source, refund uses outstanding collected funds and rejects unresolved payment attempts, and reconciliation/settled expose cumulative monotone money evidence. The selected full-replacement workflow uses those existing contracts for either correction direction. Its cost is a refund/recollection round trip and potentially finance intervention for split/external payments. The delta alternative can reduce money movement but needs cumulative adjustment allocation and revision handling across successive corrections; the classifier's preferred first answer does not establish those omitted mechanisms.

Further source review refined the selected design: `source_cancel` tests gross received money, so full refund does not guarantee a later released/void result. The concrete readiness condition instead requires a successful source-correlated cancellation outcome proving the fence, a settlement revision at least the cancellation revision, no pending collection/refund, and equal collected/refunded money. Only released with null invoice reference permits the absent-source shortcut, protected against late charge by that same permanent fence. A subsequent replacement cannot bypass an unresolved correction. These guards follow source evidence, not automatic probability approval thresholds.

Actual ownership evidence: `draft/shared/Employees.can` exports Employee with unique user and location-bound can_work; `draft/CanField.can` exports Job and owns its dispatcher/technician read policies; `draft/CanInvoice.can` owns BillingV1, BillingCancellation and source_cancel/source_refund/source_reconcile. No owner file was edited for this change. The final Can source and desired JS preserve by/guard evaluation and canonical operation identity; parsing and Node syntax checks establish syntax only. No compiler, stdlib, renderer, adapter or BDD runner was implemented or executed.

<a id="source-wording-check"></a>

## wording-check.md

All three requests preserve the same actual CanTime guards, BillingV1 signatures, Settlement fields and invoice cancellation/refund behavior. All describe equivalent period and overlap constraints, local atomic ownership and two financial alternatives. Every explanatory paragraph, instruction and option description was rewritten; exact identifiers and signatures retain meaning. Agreement is advisory; implementation guards and source evidence remain independently reviewable.
