# Can construct-help comparison pilot

**Status:** local baseline captured; external Jev and agent trials await explicit approval for these project-derived excerpts and draft files. This is a small pre-implementation evaluation, not a shipped `can dev` study.

The first unelevated Jev attempts failed inside the network sandbox before a provider response; their records are retained separately in [local-network-failures](local-network-failures). Automatic approval review then rejected the elevated request because authorization to export these particular project-derived excerpts and task-intent sentences to TypeSafe Jev was unclear. Those six records are **not** provider latency or token observations. The prepared Jev requests have not been sent.

## Frozen material

- Use the unchanged [three app tasks](../../can-dev-agent-tasks.md) and the six [observed first drafts](../can-dev-novice-20261009/findings.md). No source grammar, solution examples or acceptance checks go to a trial agent beyond the shared development feedback.
- [cases.json](cases.json) fixes six extracted construct occurrences, candidate IDs and independently assigned acceptable outcomes before any Jev response. Two cases require `unclear`; four have one target construct. The three routing controls are first structural errors, exact type spelling and unsupported `atomic`.
- Each Jev request uses the [single owned help catalog](../../../docs/specification/CONSTRUCT-HELP.md) for the same candidate signatures and meanings as the deterministic menu. It adds `none` and `unclear`. Its bounded state includes only the recorded excerpt and short task intent. The six exact [prepared requests](prepared) and their [payload audit](payload-audit.json) are reviewable; [run_rank_probe.py](run_rank_probe.py) refuses to send them if regenerated content differs.
- These extracted occurrences **do not satisfy** the proposed product trigger: all six original drafts first fail structure or indentation, and the chosen runtime profile has not qualified every candidate. Results measure exploratory ranking over documented constructs, not live compiler-guided repair accuracy.

## Two conditions on the same task

Start each arm from an independent copy of the same observed draft, with the same agent model and settings, task prompt, compiler binary/catalog, common structural diagnostic, cards, link access, check budget and stop rule. The deterministic arm presents the frozen candidate cards as a neutral ID-sorted menu with no top claim. The Jev arm presents that same menu plus only a validated Jev recommendation that passes the proposed display gate: selected construct probability at least 0.65, lead at least 0.20 and confidence at least 0.60. `none`, `unclear`, invalid and failed answers never become a replacement card. Randomize the task/arm order if running more than one agent configuration.

Run each agent for at most four source edit/check cycles and five minutes. Count the initial failed check equally in both arms. Allow only the provided help cards and compiler error text; inspect trial transcripts for any extra repository documentation or examples and exclude contaminated runs. A check cycle is an edited source followed by `can check`; record extra checks and tool calls separately. Each arm gets a fresh work directory and no conversation carryover.

## Measurements

| Measure | Exact observation and denominator |
| --- | --- |
| Full app completion | All qualified observable task checks pass through a runtime and executable examples. Report `unqualified` if the current platform cannot execute those checks; a clean source check is never full completion. |
| Source acceptance | Final `can check` exit 0 with `complete=true`, zero errors and `omitted=0`. Record compile/lowering separately. |
| Wrong suggestions | An incorrect **displayed top recommendation** relative to the frozen gold intent, per displayed recommendation and per eligible opportunity. Record wrong raw Jev choices even when the display gate suppresses them. A correct abstention is not a wrong suggestion. |
| Turns | Exact edit/check cycles plus separate agent turns, check invocations and help-link reads. |
| Tokens | Agent usage metadata summed across every turn and help read; Jev `usage.input_tokens` and `usage.output_tokens` separately and combined. Character counts are not tokens. |
| Latency | Monotonic wall time for each compiler check, deterministic formatting, Jev request and whole agent session; include failures and timeout. A multi-question Jev batch has only aggregate usage/latency. |

The local [baseline capture](local-baseline.json) pins the existing debug binary and Values catalog hashes, checks all six first drafts, and serializes neutral menus for six extracted probes. Its formatter time excludes compiler time and process startup. It does not measure agent tokens, turns or completion.

## Current validity boundary

The existing debug compiler is not a source-current rebuild. A read-only check of existing `TeamTasks.can` and `ExpenseFlow.can` was clean, but both failed compilation on multiple UI `E6008` lowering gaps. The CLI `can test` runs zero example rows. Therefore full app completion for the three prompts cannot be scored with this profile, even if an agent reaches a clean source check. Qualify an executable profile or narrow and label a source-authoring-only pilot before interpreting the paired task results.
