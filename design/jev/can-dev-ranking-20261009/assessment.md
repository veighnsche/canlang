# Construct-ranking consultation (2026-10-09)

Three independently worded, equivalent Choice requests compared default routing and evidence scope using verified compiler, catalog and novice-draft context: [request 1](01-request.json), [request 2](02-request.json), [request 3](03-request.json). The complete [response 1](01-result.json), [response 2](02-result.json) and [response 3](03-result.json) are retained. Jev `jev-1.13.0` returned probabilities and confidence, without reasons.

| Question | Request 1 | Request 2 | Request 3 |
| --- | --- | --- | --- |
| Trigger | Ambiguous after deterministic: 0.97, confidence 0.95 | Ambiguous after deterministic: 0.58, confidence 0.37; request-only 0.41 | Ambiguous after deterministic: 0.83, confidence 0.74 |
| Context | Bounded context: 0.84, confidence 0.76 | Bounded context: 0.94, confidence 0.91 | Structured only: 0.55, confidence 0.33; bounded context 0.45 |

**Assessment.** All three favor invoking Jev only for residual ambiguity after deterministic help, although request 2 nearly ties request-only and has low confidence. Two favor a bounded redacted source neighborhood; request 3 narrowly favors structured-only input with low confidence. The disagreement matters because invented words and local declaration shape are part of the evidence, while source disclosure and provider cost must remain bounded. The selected design trial uses structured facts plus a short redacted excerpt only when those facts are insufficient, and an optional explicitly supplied one-sentence task intent. It sends no full file or runtime values.

This is advice on a design comparison, not a measurement of Jev's accuracy, calibration, latency or token savings for Can. The [routing contract](../../can-dev-jev-ranking.md) records conservative abstention and fallback rules. Compare the same observed novice tasks with deterministic help and Jev ranking before treating the trigger, payload or display thresholds as accepted implementation behavior.


## Office witness design, 2026-10-11

Human authorized these exact three requests to `https://api.typesafe.ai/v1/systemone` after automatic review rejected the payload-specific transmission. Consulted once using the current Choice/HTTP documentation and existing `tools/jev.py`; no credentials, private original application source, runtime data or paths were transmitted. The normal sandbox connection failures are not model responses.

The bounded shared state identified the existing Office A5 requirement; qualified list/table cards and current read-only query/row behavior; absent unknown collection-head diagnostic; unsafe Root/When and deterministic FieldLabel controls; a synthetic OfficeChoice probe; differing required headers; and unproven completeness against global board/gallery/calendar alternatives. It explicitly described both choices as design proposals and reused the prior residual-ambiguity advice. A pursues a read-only list/table construct-card witness subject to exact slot/complete profile/equivalent authority/effects/full-header checks; B rejects that pair and preserves deterministic guidance while seeking another genuine supported slot; undecided retains a concrete unresolved design/coverage question.

The independently worded equivalent questions were:

1. Which finite next design step best satisfies the unchanged Office A5 ambiguity requirement, balancing exact candidate completeness, equivalent current authority/effects, source intent, effort and honest proposed status? Select A or B; use undecided only if an essential decision is missing. Neither choice is proof of eligibility.
2. For one bounded Office ambiguity, should the worker pursue the read-only list/table construct-card design subject to exact slot/coverage proof, or abandon that pair because the distinct headers cannot honestly support it? Compare equal safety/completeness and cost; uncertainty is allowed. Preserve source, unsafe abstention and genuine Compiler ownership.
3. Choose the smallest complete next step for a real Office help ambiguity from the verified facts: conditional list/table witness design versus rejecting that proposed pair and retaining deterministic output. Do not substitute keyword-only repair for A5, assume inventory completeness, broaden the system, or treat design advice as tested behavior.

All three selected A (.94/.91/.88 confidence; A probability .96/.94/.92). There is no material response disagreement to investigate. This supports the next finite design action, not candidate coverage, runtime acceptance, automatic help policy or a product benefit claim. Subsequent actual compilation exposed the existing Table `display=split` requirement for row children, recorded with the full valid alternatives in the ranking design. Both corrected variants compile; the unknown head remains unqualified.

Exact responses:

```json
[
  {
    "model": "jev-1.13.0",
    "answers": {
      "office_witness": {
        "type": "choice",
        "choice": "A",
        "confidence": 0.94,
        "probabilities": {
          "A": 0.96,
          "B": 0.03,
          "undecided": 0.01
        }
      }
    },
    "usage": {
      "input_tokens": 950,
      "output_tokens": 43
    }
  },
  {
    "model": "jev-1.13.0",
    "answers": {
      "office_witness": {
        "type": "choice",
        "choice": "A",
        "confidence": 0.91,
        "probabilities": {
          "A": 0.94,
          "B": 0.05,
          "undecided": 0.01
        }
      }
    },
    "usage": {
      "input_tokens": 957,
      "output_tokens": 43
    }
  },
  {
    "model": "jev-1.13.0",
    "answers": {
      "office_witness": {
        "type": "choice",
        "choice": "A",
        "confidence": 0.88,
        "probabilities": {
          "A": 0.92,
          "B": 0.07,
          "undecided": 0.01
        }
      }
    },
    "usage": {
      "input_tokens": 949,
      "output_tokens": 43
    }
  }
]
```
