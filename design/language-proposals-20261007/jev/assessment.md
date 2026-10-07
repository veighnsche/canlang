# JEV proposal advice and uncertainty

Three fresh equivalent choice requests used `jev-latest` and returned `jev-1.13.0`. All explanatory context, instructions and alternatives were independently worded; the committed baseline and correctness requirements remained the same. Requests and raw responses are preserved as `request-1.json` through `request-3.json` and `response-1.json` through `response-3.json`. The [structured assessment](assessment.json) preserves every confidence and probability; none is rounded to a yes/no verdict.

Advice concerns implementation routes for the 14 new candidates. Existing accepted designs 15–21 were not reopened because they lack complete implementation. Each route in a question bears the same prerequisite and correctness requirements. New syntax has compiler/interface/upgrade costs; package and existing-composition routes retain their actual business-source and ownership costs. Conditional readiness is distinct from potential value.

## Returned choices

| Proposal | Request 1 | Request 2 | Request 3 | Roadmap |
| --- | --- | --- | --- | --- |
| workflow | ordinary composition | ordinary composition | ordinary composition | ordinary composition; defer await grammar |
| cancellation | package | defer | package | standard targeted operations first; shared package conditional |
| compensation | package | package | package | explicit recovery operations; package extraction conditional |
| approval | defer | package | package | concrete ordinary composition pilot; stable package conditional |
| accounting | defer | package | defer | app-owned accounting pilot with ownership/evidence gate |
| bulk | derived surface | existing | derived surface | existing qualification first; derived surface conditional |
| calendar | defer | defer | package | helpers conditional; recurrence grammar deferred |
| match | defer | defer | language | enum-only comparison and bounded language candidate |
| dependent forms | language | defer | language | typed authorized-read binding candidate after form join |
| wizard | language | package | package | explicit draft model and wizard presentation conditional |
| views | existing | defer | existing | existing defaults first; typed fragment after repetition gate |
| generics | defer | defer | templates | defer grammar; concrete ordinary packages/templates |
| machines | defer | defer | defer | qualify flat first; flat reuse conditional; statecharts deferred |
| push | platform | platform | defer | measure polling; platform invalidation conditional |

## Investigation of disagreement

Choices differ on 11 of 14 subjects. The service supplied no explanatory rationale. Rewording sensitivity is substantial: language-match probability is 0.29/0.11/0.49, language-dependent-form probability 0.48/0.15/0.62, accounting-package probability 0.33/0.53/0.26, and push-platform probability 0.88/0.47/0.25. These are neither implementation-success forecasts nor evidence of calibration. The requests use the same alternatives and factual boundaries; different examples/emphasis may affect salience, but the responses cannot establish a cause. Their wording independence does not establish statistical independence.

A third independent source review investigated the uncertain decisions rather than using majority votes. [Source-grounded challenges](../review.md) and separately pinned excerpts identify actual witnesses and correct mixed draft provenance:

- Finite return analysis does not force handling of a new enum case. Closed sync outcomes justify a bounded exhaustiveness trial; an intentional booking fallback should remain allowed. Compare match with improved conditional analysis before grammar acceptance.
- Nested read/hold forms express the task but do not prove a reactive shared draft. CanRent and CanApprove support a bounded dependent-read trial with equal permission, stale-response and submission checks.
- Reusable accounting needs an owner transaction proof. The loyalty draft also shows why a universal nonnegative ledger would change legitimate reversal behavior. Pilot exact units/current ownership before any shared mutating API.
- Push must beat implemented polling on a declared load/freshness target, including connection costs. Invalidation plus authorized rereads remains the conditional route; no live modifier is accepted.
- Durable await must preserve business attempt/history evidence already stored by complete source compositions. Qualified callbacks and awaits should compete on the same complete workflow and failure matrix.

Approval/accounting pilots and a bulk surface therefore remain conditional rather than interpreted as unconditional package/API adoption. Wizard storage remains explicit, contrary to the first request's language preference. Generic package grammar and rich statecharts are deferred; low probabilities for the broader grammar alternatives are supporting advice, not the reason those choices are rejected.

Remaining uncertainty is resolved by the per-proposal witness/measurement gates in [the implementation plan](../implementation-plan.md), not by these consultations. Consequential choices exposed by those pilots require a fresh verified-context JEV triple before adoption. No proposed construct was compiled or executed during this evaluation.
