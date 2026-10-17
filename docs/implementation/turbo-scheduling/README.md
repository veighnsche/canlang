# Turbo scheduling and local cache proof

The following records the initial scheduling round and its historical source pins. The subsequent [final CI/release/documentation acceptance](evidence/final-acceptance/README.md) contains refreshed source pins, the isolated-linker policy, complete test coverage, required receipt plans, all-owner artifact packing and a new full cache replay. Use that report for the current acceptance result.

Implemented 2026-10-06 against main `7fd8c6bf4717feeffc70b46819377b74b353e117` plus the existing unmerged package/Worker repairs. [Source pins](evidence/source-pins.json) identify the tested task implementation, manifests, lock and CI files. Verified profile: macOS arm64, Node 24.21.0, Bun 1.4.2, Turbo 2.11.7, TypeScript 5.9.3 and Rust 1.99.0. This is the requested scheduling/cache cutover, with native ownership and original product gates retained.

## Implemented behavior

`bun run build` schedules all 13 TS producers from their runtime/development manifest dependencies. `build:emit` keeps each owner's real emission command; the public build wrapper cleans and executes it. Turbo uses strict environment handling and a local `.turbo/cache`; remote caching is disabled. The runner derives host/architecture, Node and Bun identities from the executing tools, checks the exact Bun/Turbo pins and hashes those identities with the lock, shared TS config and producer scripts. Caller-supplied identity labels cannot override them.

Each cacheable build also depends on its own uncached `build:prepare`. That task deletes owned emissions and incremental state even before a cache hit. Independent review reproduced Turbo's ordinary A → B → cached A extraction leaving B-only emissions behind; the prerequisite makes rollback/deletion remove those obsolete files. Producer execution also starts clean. Values catalog output and the packaged preparation binary/manifest filenames have separate ownership: TS producers preserve them, and TS cache archives exclude them. Compiled TS preparation modules remain in the archive.

Typechecks and tests depend on built producers and always execute. The ten existing owning Node commands, the root Vitest command and emitted Cloudflare runtime command retain their test sets; nonexistent transit tasks do not count as tests. Work/Cloudflare durable commands run from the repository root to preserve workerd's module filesystem behavior. `test:all` and `test:packages` schedule suites sequentially, while normal builds permit four concurrent tasks.

Compiler build/test/lint, values/work-kernel native generation and mocked Python tooling use explicit uncached tasks. The compiler's embedded Git identity cannot be hidden by an artifact cache. Ordinary builds stage committed values bindings; they do not run Rust/Wasm generation or select a backend. Existing native preparation debug prerequisites and TS receipt hashes remain in their owning CI helper. Native release/adoption stays held. The VS Code extension remains outside the Bun workspace; no Go or uv package is invented.

Release scheduling orders all producers → uncached lockstep stamp → uncached manifest → uncached verification. The node-library release workflow invokes that chain immediately before packing. Integration reproducibility performs two actual `build:uncached` executions with cache reads **and** writes disabled; the separate cache verifier cannot turn that gate into two restorations of one entry. Existing blocking TS receipts and the informational Python corpus distinction remain intact.

## Cache evidence

[The passed report](evidence/cache/report.json) retains 17 actual phases and 15 probes with raw command logs, actual Turbo summaries, dry graphs, working-byte snapshot hashes and output inventories. The verifier creates a new outside-checkout snapshot and frozen Bun install, rejects installed links outside that snapshot and never removes live outputs. [Independent review](evidence/review.json) compared all 1,177 snapshot files against the live checkout and frozen workspace with zero byte/mode differences and found no remaining concrete P1/P2 issues.

| Check | Observed result |
| --- | --- |
| Actual graph | Exactly 13 cacheable build owners plus 13 uncached preparation tasks; producer edges match runtime/development manifests. |
| Cold / unchanged warm | 13 misses / 13 hits; every preparation actually executes successfully. |
| Complete output deletion and restoration | All 2,242 files, 18,166,656 bytes, SHA-256 values and modes match the cold inventory exactly. |
| Dist deletion with incremental state retained | 13 hits restore the complete paired inventory, including three `.tsbuildinfo` files. |
| Removed/chmodded CLI | Cache extraction recreates `can-platform` with mode `0755`; full inventory remains equal. |
| Genuine upstream API change | Contracts compiles changed bytes; all 13 builds miss. A clean, cache-disabled rebuild yields the same complete mutated inventory. |
| Existing leaf API edit / source deletion | Testkit misses; 12 unrelated builds hit. Removed module JS/declaration/map files are absent. |
| A → B with extra output → cached A | All 13 builds hit after actual preparations; all B-only files disappear without manual output deletion. Reinstating B restores its extra module from cache. |
| Separate output ownership | Actual forced producer execution preserves catalog/native sentinels; subsequent empty-output cache restoration does not recreate them. |
| Producer failure | Contracts really fails compilation; all 12 dependent builds are absent from the executed-task summary, consistent with the complete baseline graph. |
| Dry invalidation probes | Lock/shared config, browser CSS, committed WASM, host/Node/Bun identities, `NODE_ENV` and `TZ` change all 13 build hashes in the tested fixtures. |

Inventories cover emitted JS, declarations, both map kinds, browser JS/CSS/manifests, required fixtures, committed binding glue/WASM/manifests, compiled preparation TS and executable modes. They do not claim byte equality only for a selected subset of output extensions.

Keep the root's real ownership declarations. Turbo's internal-dependency global identity conservatively invalidates all builds for the tested new testkit module, browser CSS and committed WASM mutations, while the tested existing testkit API edit/deletion retains 12 unrelated hits. These are observed fixtures, not a universal selectivity guarantee. Tool/host/environment probes change dry-run hash inputs; they do not execute alternate platforms or toolchains. Native/catalog/release tasks remain outside the cached TS family.

## Command verification

[The command record](evidence/verification.json) includes root/package and E2E typechecks, root integration tests, owning durable/package suites, uncached compiler tests, Python tooling, the supplemental boundary guard and its negatives. [CI audit evidence](evidence/ci/summary.json) records 12 parsed workflows, 13 passing gate/receipt tests and dry-run coverage of the retained native/editor/fixture profiles. Its unexecuted list describes that independent audit; parent execution is recorded separately below.

| Command | Result |
| --- | --- |
| `bun run typecheck` | All 13 package checks and root check execute; 40 successful tasks, including 13 cache hits and 13 preparations. |
| `bun run typecheck:e2e` | Pass; 27 successful tasks. |
| `bun run test` | All 636 root tests in 64 files pass; 13 producer hits plus actual preparations. |
| `bun run test:all` | All 38 tasks succeed: 636 root plus 4,904 owning package/runtime tests pass; one existing absent-catalog skip is exercised by the follow-up below. |
| `bun run test:compiler` | Uncached build/test pass; 909 Rust tests pass, no ignored tests. `can --version` reports current HEAD `7fd8c6b`. |
| `bun run test:tools` | Three mocked Python JEV tests pass; no credentials or external consultation required. |
| `bun run check:boundaries` | 13 owners, 678 JS/TS files, zero violations; 545 runtime/context expressions retain explicit audit scope. |
| `bun run test:boundaries` | All 12 negative/control fixtures pass. |
| Turbo's own `boundaries` command | 634 files across 13 owners; zero issues, within its previously measured coverage limits. |
| `bun run catalog`; filtered values tests | Catalog generation executes uncached; all 873 values tests pass with zero skips, including the catalog emission fixture. |
| `bun run release` | 29 tasks succeed: 13 restored builds, 13 actual preparations and three uncached release validations. |
| Installed Worker replay after restoration/release | Real tarball-only consumer passes with Node checkout reads denied; production workerd/D1 answers expected auth 401; selected CompiledWasm returns ABI 1 and add-int(1,2) = 3. Missing/corrupt WASM/CSS reject. |

Earlier combined runs caught workerd CWD regressions, now corrected in the owning test commands, and a root asset byte-comparison timeout during competing build jobs. All test sets and assertions remain enabled; no timeout threshold changed. The same asset test passed alone and the complete root suite passed once the competing jobs ended. Raw unsuccessful attempts remain alongside final results; they are not called baseline failures. The existing values catalog fixture skips when catalog output is absent; its explicit generation and follow-up owning test are recorded separately.

## Reproduce and remaining scope

Use Node 24 and Bun 1.4.2 on PATH:

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run typecheck:e2e
bun run test:all
bun run verify:turbo-cache
bun run catalog
bun run test:packages --filter=@canlang/values
bun run release
node scripts/verify-installed-worker.mjs --skip-build
```

The cache verifier prints its preserved scratch evidence path, including actual summaries and every probe. `bun run build --filter=@canlang/values` builds the owning closure; `bun run build:uncached` disables reads/writes. Prefer the public wrappers so actual tool identities participate in hashing and producer preparation runs.

Full Playwright/browser journeys, editor compilation/VSIX, values/work-kernel Rust/Wasm regeneration and loader-smoke profiles, alternate-host native releases, hosted CI receipts and remote caching were not executed or newly qualified in this round. Those existing profiles/gates remain explicit. No missing work-kernel algorithm, receipt observer, native backend default, preparation release or full installed-host acceptance follows from this proof. No merge/publication occurred, and the complete living-plan checkpoint remains unchanged.
