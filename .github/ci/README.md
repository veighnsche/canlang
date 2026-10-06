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

The verifier checks GitHub's exact workflow path and attempt job conclusion, artifact identity, receipt identity, successful command exits, and downloaded log hashes. It writes `verification.json` with source/run/job/artifact IDs. The archive digest is recorded from GitHub's API; it is not independently recomputed by this verifier. Downloaded build-output hashes are evidence recorded by the runner; binaries are not uploaded by this workflow.

A matching package receipt replaces that local gate only. Coordinator acceptance still requires its named critical witnesses, relevant joined/main checks, supported-host limits, exact writer/command release and independent Codex review. No receipt automatically authorizes merge, default-backend adoption, deployment or public release.

## Local tooling checks

```sh
node --check .github/ci/ts-gate.mjs
node --check .github/ci/verify-receipt.mjs
node --test .github/ci/ts-gate.test.mjs .github/ci/verify-receipt.test.mjs
```

The gate runner deletes generated package `dist` and top-level build metadata in its fresh candidate checkout. Invoke it only in an isolated CI checkout, never a live developer/Muse checkout.
