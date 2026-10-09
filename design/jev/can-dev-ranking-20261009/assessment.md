# Construct-ranking consultation (2026-10-09)

Three independently worded, equivalent Choice requests compared default routing and evidence scope using verified compiler, catalog and novice-draft context: [request 1](01-request.json), [request 2](02-request.json), [request 3](03-request.json). The complete [response 1](01-result.json), [response 2](02-result.json) and [response 3](03-result.json) are retained. Jev `jev-1.13.0` returned probabilities and confidence, without reasons.

| Question | Request 1 | Request 2 | Request 3 |
| --- | --- | --- | --- |
| Trigger | Ambiguous after deterministic: 0.97, confidence 0.95 | Ambiguous after deterministic: 0.58, confidence 0.37; request-only 0.41 | Ambiguous after deterministic: 0.83, confidence 0.74 |
| Context | Bounded context: 0.84, confidence 0.76 | Bounded context: 0.94, confidence 0.91 | Structured only: 0.55, confidence 0.33; bounded context 0.45 |

**Assessment.** All three favor invoking Jev only for residual ambiguity after deterministic help, although request 2 nearly ties request-only and has low confidence. Two favor a bounded redacted source neighborhood; request 3 narrowly favors structured-only input with low confidence. The disagreement matters because invented words and local declaration shape are part of the evidence, while source disclosure and provider cost must remain bounded. The selected design trial uses structured facts plus a short redacted excerpt only when those facts are insufficient, and an optional explicitly supplied one-sentence task intent. It sends no full file or runtime values.

This is advice on a design comparison, not a measurement of Jev's accuracy, calibration, latency or token savings for Can. The [routing contract](../../can-dev-jev-ranking.md) records conservative abstention and fallback rules. Compare the same observed novice tasks with deterministic help and Jev ranking before treating the trigger, payload or display thresholds as accepted implementation behavior.
