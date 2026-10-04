# Population review consultation

Prepared 2026-10-04. Advisory selection of the next complete witness, not syntax adoption.

All three requests retain the same verified source problem, owner boundary, existing mechanisms, proposed finite-cohort semantics, failure cases and alternatives. Every explanatory state, instruction and option description is separately rewritten; stable technical identifiers and option keys are intentionally preserved. The shared-runtime allowance applies to **all** choices: the authored choice may reuse indexed traversal, and periodic review explicitly includes complete initialization rather than being compared as a knowingly incomplete existing feature. No option is assumed to have implementation or performance evidence.

The finite cohort reconciles current state, not historical event-time membership. Durable immutable insertion order/cutoff, full-prefix traversal, current child reads, atomic child admission/checkpoint, stable child identity and independent failure recovery remain proof obligations for every candidate. The consultation does not create such a facility.

Pre-send check: all three JSON requests contain `allocation:choice` with the same `authored`, `periodic`, `enumerated` options. State text, instructions and every corresponding option differ across the three; a manual semantic comparison found no changed workload, exception, cost category or guarantee. Results and uncertainty will be appended after the calls.

## Partial results and approval boundary

| Request | Outcome | Confidence | P(authored) | P(periodic) | P(enumerated) |
| --- | --- | --- | --- | --- | --- |
| 1 | enumerated | 0.66 | 0.22 | 0.00 | 0.78 |
| 2 | Not sent; automatic approval review rejected disclosure | — | — | — | — |
| 3 | enumerated | 0.82 | 0.11 | 0.01 | 0.88 |

Both completed calls used `jev-1.13.0`; exact returned probabilities, requests and usage are in their result files. The two choices agree but give different distributions. The classifier gives no rationale establishing the cause. Neither averaging nor an approval threshold is used.

Request 2 was rejected as substantial nonpublic design disclosure lacking payload-specific authorization. A direct re-review of the unchanged request quoted the user's explicit standing authorization to send relevant CanLang design context; automatic review rejected it again. The second reason treated that quotation in the tool justification as untrusted and still required payload-specific approval. No alternate route, reduced substitute or indirect resend was attempted. The coordinator asked the user to approve the exact linked request; this third consultation remains pending that answer. Saved rejection details are in `2.blocked.json`, which is an approval record, not a JEV response.

The required three-consultation set is incomplete, so no enumeration syntax or runtime contract is selected here. Independent app corrections continue. A future selected witness must still demonstrate finite-cohort traversal, fresh eligibility, duplicate/crash recovery and isolated child failure; classifier advice does not supply those guarantees.
