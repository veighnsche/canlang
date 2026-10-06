# Remote TypeScript gates

Run required package gates on independent standard GitHub-hosted Ubuntu runners. Public CanLang runner minutes are free; each job has private checkout/build outputs. Remote jobs do not consume the local coordinator TS-command slot. Readiness and exact-file ownership still apply.

## Request a gate

Commit the exact candidate snapshot to its own lane branch and push it so GitHub can fetch it. A testable WIP commit is permitted; it does not mean lane acceptance. Never include another writer's uncommitted files or switch a shared checkout. The tooling workflow must be present on the default branch for manual dispatch. The bootstrap branch also runs a `values` gate on push.

```sh
gh workflow run ts-gates.yml -R veighnsche/canlang --ref main \
  -f source_sha=<full-candidate-commit-SHA> \
  -f task_id=<coordinator-task-or-grant-ID> -f gate=interfaces
```

Profiles: `values`, `state`, `stdlib`, `identity`, `ui`, `interfaces`, `work`, `cloudflare`, `testkit`, `workspace`, or `all` (independent matrix jobs, up to seven at a time). Each installs the locked dependencies, builds its producers, typechecks and runs the package's real tests. `workspace` runs the root Vitest scope, which does not replace other package suites. No compiler/corpus, Rust or installed-release qualification is implied. The `draft` submodule is not fetched by these TS jobs.

Record requested source SHA, task/profile, trusted workflow commit, run ID/attempt, URL, current status and deadline. Do not run a duplicate local gate while the same command is already running remotely. A different accepted source snapshot needs its own gate.

## Verify the receipt

A job uploads `ts-gate-<run-ID>-<attempt>-<profile>` containing `receipt.json` and per-command logs. The receipt records source/workflow SHAs, lock checksum, runtime versions, exact argv/cwd, exits/signals/timeouts, observed counts, log checksums and generated-output checksums. Failed/skipped gates cannot produce a passing receipt. Independent tests still run after a typecheck failure; producer failures explicitly skip dependent commands.

```sh
node .github/ci/verify-receipt.mjs --repo veighnsche/canlang \
  --run <run-ID> --attempt 1 --sha <full-candidate-SHA> \
  --workflow-sha <trusted-workflow-commit-SHA> \
  --profile interfaces --task <task-ID> \
  --dir /private/tmp/<unique-empty-receipt-directory>
```

The runner and verifier share the bounded command contract in `gate-plan.mjs`.
A passing receipt must contain every selected profile command in its declared
order, with exact argv, source/package working directory, test identity and
explicit native environment. This includes the SHA and Node/Bun version probes,
frozen install, owning producer build, typecheck, real tests and final tracked-tree
diff check. Values retains its catalog command; Cloudflare retains both source
Vitest and emitted runtime tests; workspace retains boundary checks and root
Vitest without claiming the other package suites.

The verifier checks GitHub's exact workflow path and attempt job conclusion,
artifact identity, receipt identity, complete command coverage, successful exits
and downloaded log hashes. It recomputes counts from those logs and requires
positive passing execution for every declared test command; absent counts,
zero tests, all-skipped tests and reported failures reject. Revision/version logs
must agree with the advertised source SHA and Node24/Bun1.4.2 pins. Native
profiles also require Rust/Cargo1.99.0 logs and the planned private target/binary
environments. Receipts predating `plan_version: 1` and the complete command
metadata need a fresh run using compatible trusted workflow tooling. It writes `verification.json` with source/run/job/artifact IDs. The archive digest is recorded from GitHub's API; it is not independently recomputed by this verifier. Downloaded build-output hashes are evidence recorded by the runner; binaries are not uploaded by this workflow.

A matching package receipt replaces that local gate only. Coordinator acceptance still requires its named critical witnesses, relevant joined/main checks, supported-host limits, exact writer/command release and independent Codex review. No receipt automatically authorizes merge, default-backend adoption, deployment or public release.

## Native prerequisite (cloudflare/workspace only)

Those profiles' tests spawn the `can-preparation` binary, which a cold runner
lacks (only `darwin-arm64` is packaged). After the SHA check and before tests,
the gate installs pinned toolchain 1.99.0 (`--profile minimal`), records
`rustc`/`cargo` versions, and runs an isolated `--locked` debug build of
`packages/cloudflare/preparation` with a private `CARGO_TARGET_DIR` outside the
checkout. Test children receive the built binary via `CAN_PREPARATION_BIN`.
Crate lockfile, toolchain file, and built executable hashes land in
`receipt.native_prerequisite`; logs/hashes upload, never the target dir or
binary. A failed prerequisite fails the receipt and skips dependent tests.
Other profiles run no native prerequisite. The verifier rejects receipts that
omit/fail it, carry malformed binary/lock/toolchain hashes, or advertise inconsistent target paths and child environments. The runner hashes the actual prerequisite files; the verifier does not download or independently re-hash those native files.

## Local tooling checks

```sh
node --check .github/ci/gate-plan.mjs
node --check .github/ci/ts-gate.mjs
node --check .github/ci/verify-receipt.mjs
node --test .github/ci/ts-gate.test.mjs .github/ci/verify-receipt.test.mjs
```

The gate runner deletes generated package `dist` and top-level build metadata in its fresh candidate checkout. Invoke it only in an isolated CI checkout, never a live developer/Muse checkout.
