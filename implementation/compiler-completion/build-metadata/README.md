# FAIL-R04 build metadata verification

Run `python3 implementation/compiler-completion/build-metadata/verify.py` from the repository root. The dependency-free harness copies the current build script into temporary independent Cargo consumers, then deletes the fixtures. `verification.json` retains the successful local run.

Expected commits come from each fixture's full Git log identity, abbreviated to seven characters under explicit fixture Git configuration. Actual values come from the consumer executable's compiled environment. Every Cargo case also verifies that every emitted watch exists and that a second unchanged build preserves the build-script output's modification time. Cases cover ordinary branch commits, packed refs, packed-to-loose commits, detached HEAD movement, linked worktrees with loose and packed refs, worktree commits, no-Git source, and unborn HEAD. A separately compiled script executed with an empty PATH verifies unavailable-Git fallback.

The change uses Git to resolve HEAD, symbolic refs, and packed-ref paths. A missing loose ref watches its nearest existing parent, allowing subsequent loose-file creation to trigger a build. Existing metadata paths avoid the observed repeated missing-path rebuilds. Directory watches can also invalidate for other changes beneath that directory; this is a correctness-oriented fallback, not a minimal-invalidation guarantee.

Qualification is local native debug Cargo/Git, with UTF-8 temporary paths and the installed toolchain. No stale-version defect, every-platform guarantee, non-UTF-8-path guarantee, performance benchmark, or new dependency is claimed. This harness does not build the full compiler.
