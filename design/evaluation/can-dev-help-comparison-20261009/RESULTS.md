# Can construct-help comparison: current observations

**Status (2026-10-09):** local baseline complete; the paired Jev and coding-agent comparison has not run. The exact [protocol](PROTOCOL.md), [frozen cases](cases.json), [local measurements](local-baseline.json) and [rank scorer](score_rank_probe.py) are ready. Do not interpret absent Jev or agent observations as zero errors, zero tokens or zero latency.

| Requested measure | Deterministic local observation | Jev / paired agent observation |
| --- | --- | --- |
| Full app completion | Unqualified: the current runtime cannot execute the three tasks' full UI and example checks. | Unmeasured. |
| Source acceptance | The six first drafts all fail `can check`; four first report `E1211` top-level structure and two `E1103` indentation. | No revised agent sources yet. |
| Wrong suggestions | Six frozen extracted probes have neutral menus with no promoted construct. This makes wrong **promoted** suggestions inapplicable, not proof of useful guidance. Each menu contains its predeclared acceptable construct or abstention option. | Unmeasured; no provider response or displayed rank. |
| Edit/check turns | No agent continuation has run. | Unmeasured. |
| Tokens | Six serialized neutral menus total 6,739 UTF-8 bytes; bytes are not model tokens. | Agent and Jev tokens unmeasured. |
| Latency | One local check per raw draft: 4.698–35.959 ms, median 6.325 ms. Neutral menu formatting: 0.009–0.052 ms per probe, median 0.0165 ms, excluding parsing, process startup and transport. | Jev and agent latency unmeasured. The six pre-provider sandbox failures are not Jev latency samples. |

The local check uses the existing `can 0.1.0` debug binary and the current Values catalog, both pinned by SHA-256 in [local-baseline.json](local-baseline.json). Drafts produced 18–62 diagnostics each. The first structural errors make all six deeper construct occurrences in the probe set **ineligible for an automatic Jev call** under the proposed [routing contract](../../can-dev-jev-ranking.md). A rank result on these extracted snippets would be a controlled offline probe, not evidence of the development server handling a live diagnostic.

The same debug binary returned `E6008` for all 13 `TeamTasks.can` compile diagnostics and all 11 `ExpenseFlow.can` compile diagnostics in this local capture. Those existing apps are feasibility witnesses for portions of the authoring design, not an executable acceptance harness for the three new tasks. The current `can test` CLI also reports zero executed example rows. A clean `can check` result after agent edits would measure source acceptance only.

The first attempt to call Jev from the ordinary sandbox failed before network delivery; [those six failures](local-network-failures) are kept outside the Jev response directory. Automatic approval review rejected the elevated external call because the six packets include private project-derived source excerpts and task-intent text and authorization to export those exact packets was unclear. The exact [prepared packets](prepared) contain no full files, paths, credentials or runtime values; the [local audit](payload-audit.json) records their sizes and hashes. A user approval request is pending for the TypeSafe Jev packets and paired ephemeral Codex agent trials. No external response is counted in [rank-scores.json](rank-scores.json).
