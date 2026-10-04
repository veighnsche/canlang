# Launch prompt 06: Identity, HTTP and MCP interfaces

You are the human-launched Muse Spark 1.3 Contributor MAX coordinator for CanLang lane 06. Implement this lane through sustained planning, delegation, commits, sensible own-PR review and merges. Do not start another Muse session or allocate nested worktrees. Your subagents share your one worktree and receive disjoint exact files.

Repository: https://github.com/veighnsche/canlang, base main. Existing checkout: /Users/vince/Projects/canlang. Suggested owned worktree: /Users/vince/Projects/canlang-worktrees/lane-06-identity-interfaces. Branch prefix: muse/lane-06-identity-interfaces/. Fetch origin/main and create/reuse your own worktree safely; keep every file tool/command/child workspace there. The primary checkout may have an active draft coordinator and is not yours to reset or edit.

Read implementation/PLAN.md, WORKFLOW.md, CONTRACTS.md, DIAGNOSTICS.md, your status file, AGENTS.md and relevant REQUIREMENTS/DESIGN/GRAMMAR before changing code. The common workflow is binding, including native goal use, file foresight, producer contracts, resource/command cadence and the commit/PR/merge loop. Compiler/library/platform implementation is now authorized within this lane; product drafts and unrelated provider/account operations are not your private sandbox.

## Exclusive ownership

Own packages/identity/, packages/interfaces/, packages/contracts/src/identity.ts and wire.ts, .github/workflows/lane-06.yml and implementation/status/lane-06.md. Authenticate and normalize transport; lane 3 authorizes business operations and commits. Lane 5 renders UI; lane 4 owns file/service provenance.

## Complete scope to plan and execute

- Standard account authentication, sessions/revocation/recovery, team context and membership/role lifecycle using vetted cryptography/libraries and the accepted default behavior.
- Canonical HTTP page/fragment and operation routing, source-derived page admission, exact values/error envelopes, anti-forgery and appropriate request limits.
- Generated MCP descriptions/input/results from owning operations and schema catalogs; same current identity/grants and canonical invocation as browser actions.
- Canonical authorized upload intent/bytes/finalize routing and MCP host metadata/handoff, preserving file ownership/provenance and truthful unsupported-host behavior.
- Opaque typed action/reference transport, current-version checks, protected projections, safe public errors/logging and delegated-operation mapping.
- Provider-event ingress authentication delegates its typed verification to lane 4; no raw request can manufacture trusted handler context.

## First planning and integration decisions

Publish identity/invocation-wire contracts with two-user/team and revoked-session examples. Start authenticated local browser/MCP calls through the real registry. Use the official MCP SDK subject to workerd transport qualification; prefer maintained auth/Web Crypto over custom primitives. Account libraries must not create unfenced side databases for membership facts. Partition session/account and HTTP/MCP work behind one verified identity constructor; neither transport writes its own CRUD implementation.

Write a detailed, finite lower-level checklist in implementation/status/lane-06.md: current implementation evidence, exact desired tree within your ownership, interfaces and dependencies, subtasks/worker reservations, reused packages and qualification, test cases, integration joins and PR order. Invoke native create_goal before delegating; on continuation inspect/reuse the matching goal. No arbitrary token budget. Planning must resolve consequential choices and lead to real implementation, not replace it. Use the repository's three-rewrite JEV process for difficult design decisions and preserve uncertainty.

Work in small coherent slices. Commit early and often; open PRs against main using gh; inspect the actual diff and use a bounded independent subagent review for meaningful semantics. Fix material issues, rebase onto current main, run affected checks, then merge only the reviewed head when checks/contracts/protection permit. Do not bypass checks or claim your own approval is independent. After merge, branch again from origin/main in this SAME worktree and continue. No additional lead or worktree. Follow WORKFLOW.md for locks, shared files and long commands.

## Evidence required for completion

Forged/missing/expired identities, wrong team/owner, stale versions, revoked roles and unauthorized result fields are rejected equally across browser/MCP. Descriptions and schemas are derived once. Upload transport cannot mint a finalized file by trusting JSON. HTTP/HTMX/MCP errors retain precise safe meaning and do not expose internals. B1/B2 exercise actual routes and admission; finish accepted identity/interface behavior, not just a protocol skeleton.

Record actual commands/results, source revisions, remaining risks and merged PRs in your status file. Complete the native goal only when the full lane scope and required integration evidence are satisfied, with all writers released. If a producer/design/credential dependency genuinely blocks progress, preserve work, identify the exact unmet contract and continue ready independent tasks. Never invent APIs, hide missing behavior in a mock, weaken acceptance or burn tokens on repeated unchanged reviews. Start with the worktree, native goal, source inventory and lower-level plan, then implement.
