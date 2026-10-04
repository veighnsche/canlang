# Lane partition decision and uncertainty

The user first asked for five lanes, then explicitly allowed more to divide the likely larger standard-library effort. The initial five-lane comparison is preserved in five-lane-review.md; it is superseded by the changed scheduling constraint.

Requests 4–6 compare A: seven lanes against B: eight, splitting provider/files from durable work. All explanatory text was reworded while retaining factual scope, uncertainty and alternatives. Complete requests/responses are adjacent. No threshold or vote settled the design.

| Request | Choice | Confidence | P(seven) | P(eight) |
| --- | --- | --- | --- | --- |
| 4 | B | 0.19 | 0.41 | 0.59 |
| 5 | A | 0.89 | 0.94 | 0.06 |
| 6 | A | 0.21 | 0.6 | 0.4 |

The recommendations disagree: one weakly prefers eight, one strongly prefers seven, and one weakly prefers seven. This is material wording sensitivity despite matched facts, not evidence of unanimous validation. No measured throughput or effort data is present. The initial five-lane round similarly changed choices, so both rounds counsel against claiming an objectively proven optimal partition.

Decision: start with seven because values, state, durable services and UI now have distinct library owners, while file provenance and receipt/dispatch behavior retain one interface owner. This resolves the user's concentration concern without creating another provider/effect handoff before the first real integration. A scoped independent architecture review confirms pure values/schema work is substantial and query authority belongs entirely with state; identity writes join that same commit path. Those boundary corrections are incorporated in CONTRACTS.

Remaining imbalance risk is explicit: lane 1 includes the full Rust toolchain, lane 3 is correctness-heavy, and lane 4 has broad adapters/files. Internal file-partitioned workers address immediate parallelism. After the first integrated app, compare actual remaining milestones/waiting time. If lane 4 materially dominates, a future human-launched file-lifecycle lane is a coherent split with explicit ownership transfer; no coordinator may silently create it. Seven is a reasoned starting plan, not a capacity guarantee.
