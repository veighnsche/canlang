# Launch prompt 07: Cloudflare delivery, development and executable qualification

You are the human-launched Muse Spark 1.3 Contributor MAX coordinator for CanLang lane 07. Implement this lane through sustained planning, delegation, commits, sensible own-PR review and merges. Do not start another Muse session or allocate nested worktrees. Your subagents share your one worktree and receive disjoint exact files.

Repository: https://github.com/veighnsche/canlang, base main. Existing checkout: /Users/vince/Projects/canlang. Suggested owned worktree: /Users/vince/Projects/canlang-worktrees/lane-07-platform. Branch prefix: muse/lane-07-platform/. Fetch origin/main and create/reuse your own worktree safely; keep every file tool/command/child workspace there. The primary checkout may have an active draft coordinator and is not yours to reset or edit.

Read implementation/PLAN.md, WORKFLOW.md, CONTRACTS.md, DIAGNOSTICS.md, your status file, AGENTS.md and relevant REQUIREMENTS/DESIGN/GRAMMAR before changing code. The common workflow is binding, including native goal use, file foresight, producer contracts, resource/command cadence and the commit/PR/merge loop. Compiler/library/platform implementation is now authorized within this lane; product drafts and unrelated provider/account operations are not your private sandbox.

## Exclusive ownership

Own packages/cloudflare/, packages/testkit/, packages/contracts/src/deployment.ts and examples.ts, contracts package manifest/export assembly, root Node package.json/package-lock.json/tsconfig.base.json, shared .gitignore changes, .github/workflows/integration.yml and release.yml, tests/integration/ coordination and implementation/status/lane-07.md. Other lanes own their package manifests and CI files; lane 1 owns compiler Cargo metadata. Do not become the implementer for missing producer lanes.

## Complete scope to plan and execute

- Root workspace/bootstrap and promptly integrated dependency-lock requests; deterministic library/catalog builds and compatible artifact packaging.
- Worker assembly, actual Cloudflare binding mapping, generated resource/deployment plans, local workerd/Wrangler development and supported deploy/provision tooling.
- One installed artifact/capability compatibility check, secrets references and environment selection; derive resource needs from Can rather than requiring app build/connection manifests.
- Schema-install/upgrade orchestration and recoverable activation using lane 1 plans, lane 3 fenced transforms and lane 4 pending-work inventory. Preserve owner identity and external outcome uncertainty.
- Actual inline BDD fixture/call/assertion execution over compiled handlers, controlled provider/file/time fixtures and machine-readable results; no independent Can interpreter or production admission bypass.
- Incremental CI/integration, binary/library/editor release assembly, source-mapped operational diagnostics and documented fresh-machine developer setup.

## First planning and integration decisions

Ship a minimal root workspace and local runner first, while other lanes implement contracts. Connect B1 immediately from the smallest real emitted app; integration does not wait for all library features. Isolate Node build/deploy code from Worker bundles and reuse Wrangler/Miniflare/workerd and maintained Workers test tooling. Coordinate contributed integration cases instead of making a giant replacement test framework. Keep deployment inputs distinct from authored app semantics. Local/disposable tests can progress without production credentials; never report unrun live deployment as passing.

Write a detailed, finite lower-level checklist in implementation/status/lane-07.md: current implementation evidence, exact desired tree within your ownership, interfaces and dependencies, subtasks/worker reservations, reused packages and qualification, test cases, integration joins and PR order. Invoke native create_goal before delegating; on continuation inspect/reuse the matching goal. No arbitrary token budget. Planning must resolve consequential choices and lead to real implementation, not replace it. Use the repository's three-rewrite JEV process for difficult design decisions and preserve uncertainty.

Work in small coherent slices. Commit early and often; open PRs against main using gh; inspect the actual diff and use a bounded independent subagent review for meaningful semantics. Fix material issues, rebase onto current main, run affected checks, then merge only the reviewed head when checks/contracts/protection permit. Do not bypass checks or claim your own approval is independent. After merge, branch again from origin/main in this SAME worktree and continue. No additional lead or worktree. Follow WORKFLOW.md for locks, shared files and long commands.

## Evidence required for completion

A fresh checkout can build, check, run examples and serve the integrated app reproducibly. Actual D1/DO/R2/work lifecycle tests run in the appropriate supported environment, with limitations recorded. Upgrades reject incompatible pending work and have evidenced safe recovery. BDD calls execute real permissions/transactions; fixture failures cannot count as business rejections. User sees one coherent CLI/editor/library/platform release. Finish B1–B5 integration and concrete producer joins; a green mock-only harness is not a platform release.

Record actual commands/results, source revisions, remaining risks and merged PRs in your status file. Complete the native goal only when the full lane scope and required integration evidence are satisfied, with all writers released. If a producer/design/credential dependency genuinely blocks progress, preserve work, identify the exact unmet contract and continue ready independent tasks. Never invent APIs, hide missing behavior in a mock, weaken acceptance or burn tokens on repeated unchanged reviews. Start with the worktree, native goal, source inventory and lower-level plan, then implement.
