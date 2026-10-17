# Session control and replay consultation — 2026-10-09

Three independently worded equivalent Choice requests compared the same first control transports and replay boundaries using verified, abstracted facts about the current JSON commands, in-process worker, test bridge, zero-row CLI and incomplete fixture capture. No source files, paths, user task text, credentials or runtime values were sent. The complete [first](01-result.json), [second](02-result.json) and [third](03-result.json) request/response records are retained beside their request files. Jev `jev-1.13.0` returned probabilities and confidence, without rationale.

| Choice | Request 1 | Request 2 | Request 3 |
| --- | --- | --- | --- |
| First control transport | JSON CLI 0.82, confidence 0.73 | JSON CLI 0.97, confidence 0.95 | JSON CLI 0.79, confidence 0.69 |
| Replay boundary | Isolated rerun 1.00, confidence 1.00 | Isolated rerun 1.00, confidence 1.00 | Isolated rerun 0.89, confidence 0.83; exact-first 0.10 |

The answers are directionally consistent. The packet explicitly noted existing JSON conventions and the cost of adding client registration, which may favor the CLI framing; Jev gave no reason that would resolve this bias. The [selected design](../../can-dev-session-control.md) starts with a JSON CLI over a private session owner, retains MCP as a later adapter over the same facts, and labels a new isolated example execution as a rerun. It does not claim exact replay while actor, clock, resource and provider state cannot be restored. This is advisory design evidence, not proof of agent adoption, fewer tokens, secure attachment or deterministic rerun behavior.
