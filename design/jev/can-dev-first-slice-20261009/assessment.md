# First supported slice consultation — 2026-10-09

Three independently worded equivalent Choice requests compared an authoring-only slice, the existing lifecycle app as a release slice, a single-file team tracker with that lifecycle app as prerequisite, and all three proposed app tasks at once. The requests used verified abstract facts about current compiler/runner seams; no source files, paths, credentials, complete task prompt or runtime values were sent. The full [first](01-result.json), [second](02-result.json) and [third](03-result.json) request/response records are retained beside their request files. Jev `jev-1.13.0` returned probabilities and confidence, not reasons.

| Request | Selected option | Probability | Confidence | Next material option |
| --- | --- | ---: | ---: | --- |
| 1 | Single-file team tracker | 0.95 | 0.93 | Lifecycle app 0.05 |
| 2 | Single-file team tracker | 0.83 | 0.77 | Authoring only 0.15 |
| 3 | Single-file team tracker | 0.93 | 0.91 | Lifecycle app 0.05 |

The answers consistently favor a complete small agent task over calling a narrower infrastructure probe the first product slice. The prompt foregrounded whole-app completion, so this is advice rather than independent proof of feasibility or agent benefit. The [selected slice](../../can-dev-first-slice.md) uses the existing lifecycle app as a same-source engineering gate and the office-supplies task as the first supported agent-facing profile. Source-current compilation, authentication, example execution, help quality and agent completion remain to be demonstrated before support is claimed.
