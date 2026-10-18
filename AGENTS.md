# Working on Can

- Prioritize the user's requirements, adoption, simplicity, and token efficiency. Keep design assumptions open to revision.
- Express app identity and composition in `.can` source. Derive dependencies and interfaces from owning declarations; use shared defaults and reusable components to keep authoring concise.
- Address missing capabilities in the language design while preserving complete workflows, edge cases, permissions, and evaluation order. Use `##` for explanatory comments and keep executable bindings inside `do`.
- Make focused changes and run checks appropriate to them. Preserve inline behavior examples and report what was verified, what remains proposed, and any gaps.
- Validate changed behavior once with proportionate direct checks and a concise outcome. Reuse unchanged results. Do not create nested proof packets, reviews of reviews, tests of testing code, hash-manifest chains or duplicated verification snapshots. Repeat checks only after a relevant edit, actual failure or concrete unresolved risk.
- Evaluate alternatives fairly against the same outcomes and evidence. Assess draft designs at their declared stage, distinguishing desired generated output from implemented APIs.
- For difficult design decisions, consult JEV with verified context and balanced alternatives. Calls are preauthorized. Use the appropriate question type and three independently worded, equivalent requests; save responses and uncertainty, investigate disagreement, and treat results as advice.
- Keep work moving with reasonable implementation choices. Delegate independent work when useful, with focused context.
- Record project, design, and implementation decisions in [DECISIONS.md](docs/specification/DECISIONS.md), with the choice, rationale, and any remaining uncertainty. Label proposals separately from accepted decisions.
- After every merge, the person or agent handling it must reconcile the [living file-tree plan](docs/ideal-filetree-plan.md) against all changes since its checkpoint, update coverage and decisions together, and advance the checkpoint only when review is complete. Bookkeeping does not require recursive self-updates; plan maintenance does not authorize implementation.

## Finite execution

- Each plan has one current execution view. Keep canonical task IDs; count a shared outcome once and link its consumers. Historical progress notes provide evidence, not additional assignments or permission to reopen accepted criteria.
- Before dispatch, identify the required observable outcome, defining owner, concrete prerequisite output, remaining change and finite acceptance condition. If an existing requirement is underspecified, name the exact decision needed; do not invent a stricter prerequisite or an unlimited "broader/full" capability obligation.
- Close a satisfied criterion at its recorded scope. A parent may remain open for listed unmet criteria, but its accepted components do not need new intake-only commits, duplicate evidence or unchanged qualification runs. Dependency handoffs require the needed output, not completion of another owner's entire plan.
- Use the smallest complete implementation preserving required permissions, evaluation order, atomicity, failure and recovery behavior. New carriers, abstractions, dependencies and profiles require an existing accepted requirement or demonstrated gap in the current mechanism. Optional improvements remain separately proposed.
- Extra verification or review must address a relevant change, actual failure or distinct unresolved risk. State the scope and outcome concisely in the existing record. Do not review review verdicts or build verification frameworks around ordinary checks.
- Delegate finite independent work only when it improves total time, cost or quality. Use focused context and an economical reliable model; communicate actionable dependencies, corrections and decisions rather than routine acknowledgements or unchanged status.
- Isolate or freeze inputs during capture-sensitive integration runs. Parallel work must not mutate their consumed producer/output closure. Retry only the affected failed or invalidated scope and reuse the rest.
- Reconcile merges incrementally from retained coverage while accounting for every change since the checkpoint. Reuse unchanged owner/target review; do not reconstruct the same history manually at every intake or recursively register bookkeeping. Keep the complete checkpoint unchanged until its required review is complete.
- Stop an owned task when its declared acceptance is met. Record genuinely held/external gates with their owner and release condition, continue independent ready tasks, and distinguish finishable authorized work from completion that still requires a human or external release.

## Reduce process overhead

- Reduce waste, not correctness coverage: reproduce a shared defect, fix its owning mechanism, and run focused checks. Reuse unchanged results; run expensive combined checks for a meaningful batch or a concrete integration risk, not after every small edit.
- Keep decisions and outcomes concise in their existing owning records. Do not create extra plans, evidence summaries, status files or bookkeeping commits unless they resolve a concrete need.
- Review handed-off work asynchronously. Continue independent, dependency-ready implementation while review is pending; deliver concrete findings and repair the affected scope without blocking unrelated work. Pending review alone is not a reason to stop.
- Continue already-authorized work without per-step approval requests. Ask only for a genuine missing decision or permission; do not expand the scope or interrupt active work merely to add process.

## Build resources

- Do not multiply `compiler/target` or `node_modules` across disposable agent worktrees when compatible caches are available. Before reuse, check lockfiles, toolchain, features, build flags and workspace-link destinations; serialize writers to a shared target. An incompatible build needs its own explicitly owned cache.
- Use the existing compatible compiler target with `CARGO_INCREMENTAL=0`, `CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_TEST_DEBUG=0` and `CARGO_BUILD_JOBS=2` unless the assigned validation requires another profile. Keep required features, assertions and test stack sizes; do not alternate cache flags or rebuild merely to inspect filtered diagnostics.
- After validation and command/capture release, clean task-owned rebuildable `target/debug` and private dependency installs in disposable worktrees. Preserve required binaries, artifacts and evidence; retain a cache when a later consumer still needs it. Never delete source, Git data, worktree roots, logs or foreign/shared outputs. Owner release and inactive processes must be verified; absence of open files alone is insufficient.
- Check free disk space before allocating another large build/dependency tree. When space becomes constrained, defer new disk-heavy commands and report the concrete resource need while continuing independent ready work. Cleanup has an explicit owner and scope; it is not permission to interrupt another build.
