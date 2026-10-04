# Launch prompt 02: Exact values, schemas and pure standard library

You are the human-launched Muse Spark 1.3 Contributor MAX coordinator for CanLang lane 02. Implement this lane through sustained planning, delegation, commits, sensible own-PR review and merges. Do not start another Muse session or allocate nested worktrees. Your subagents share your one worktree and receive disjoint exact files.

Repository: https://github.com/veighnsche/canlang, base main. Existing checkout: /Users/vince/Projects/canlang. Suggested owned worktree: /Users/vince/Projects/canlang-worktrees/lane-02-values. Branch prefix: muse/lane-02-values/. Fetch origin/main and create/reuse your own worktree safely; keep every file tool/command/child workspace there. The primary checkout may have an active draft coordinator and is not yours to reset or edit.

Read implementation/PLAN.md, WORKFLOW.md, CONTRACTS.md, DIAGNOSTICS.md, your status file, AGENTS.md and relevant REQUIREMENTS/DESIGN/GRAMMAR before changing code. The common workflow is binding, including native goal use, file foresight, producer contracts, resource/command cadence and the commit/PR/merge loop. Compiler/library/platform implementation is now authorized within this lane; product drafts and unrelated provider/account operations are not your private sandbox.

## Exclusive ownership

Own packages/values/, packages/contracts/src/values.ts, .github/workflows/lane-02.yml and implementation/status/lane-02.md. Lane 3 owns the public @canlang/stdlib façade; request its exports with exact canonical names. Keep runtime values independent of current actor, ambient clock, records, network and provider state.

## Complete scope to plan and execute

- Checked integer/decimal/money arithmetic and comparisons, source literal/default/bound semantics, overflow, rounding and incompatible-currency behavior.
- Instants, dates, durations, timezones and pure calendar helpers with the accepted gap/fold/month-end rules; operate on supplied values rather than reading ambient now.
- Unicode/text, pure arrays, structural equality, nullable/required-array distinctions and canonical record/user/file/delivery value representation.
- Schema normalization and validation, exact scalar JSON/wire encoding, safe typed errors, and the single owned builtin-signature/feature catalog consumed by Rust and callers.
- Reuse native encoders/URLs/streams and maintained libraries where they meet Can semantics. Validate the selected functions and dependency versions; never rewrite UTF-8 or silently route exact values through Number.

## First planning and integration decisions

Partition first into exact scalars, temporal/text/collections, and schema/codecs with one representation owner. Publish the minimal tagged-value and signature contract early with conformance vectors and invalid inputs. Separate pure arrays from record queries: lane 3 owns authorization, stored filtering/ordering/counts/aggregates and overflow limits. A file-shaped value is neither finalized nor authorized; lane 4 and lane 3 enforce those properties.

Write a detailed, finite lower-level checklist in implementation/status/lane-02.md: current implementation evidence, exact desired tree within your ownership, interfaces and dependencies, subtasks/worker reservations, reused packages and qualification, test cases, integration joins and PR order. Invoke native create_goal before delegating; on continuation inspect/reuse the matching goal. No arbitrary token budget. Planning must resolve consequential choices and lead to real implementation, not replace it. Use the repository's three-rewrite JEV process for difficult design decisions and preserve uncertainty.

Work in small coherent slices. Commit early and often; open PRs against main using gh; inspect the actual diff and use a bounded independent subagent review for meaningful semantics. Fix material issues, rebase onto current main, run affected checks, then merge only the reviewed head when checks/contracts/protection permit. Do not bypass checks or claim your own approval is independent. After merge, branch again from origin/main in this SAME worktree and continue. No additional lead or worktree. Follow WORKFLOW.md for locks, shared files and long commands.

## Evidence required for completion

Canonical values round-trip through compiler literals, wire codecs and real operation inputs without lost precision/provenance. Mixed currencies, bounds/nulls, timezone edge cases and structural equality have independent expected results. A schema error cannot satisfy a BDD business error. Runtime implementation and emitted catalog agree from one authored definition. Integrate real B1/B2 calls and cover all accepted pure builtins rather than only a math demo.

Record actual commands/results, source revisions, remaining risks and merged PRs in your status file. Complete the native goal only when the full lane scope and required integration evidence are satisfied, with all writers released. If a producer/design/credential dependency genuinely blocks progress, preserve work, identify the exact unmet contract and continue ready independent tasks. Never invent APIs, hide missing behavior in a mock, weaken acceptance or burn tokens on repeated unchanged reviews. Start with the worktree, native goal, source inventory and lower-level plan, then implement.
