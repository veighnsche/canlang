# Pass10 frozen compiler checks

Checks ran against the frozen compiler source after formatting commit `db495c6`. No compiler, package, or shared documentation files were edited for this check packet. The exact approved environment overrides were `CARGO_BUILD_JOBS=1`, `CARGO_INCREMENTAL=0`, `CARGO_NET_OFFLINE=true`, and `CAN_COMPLETION_REQUIRE_ENGINES=1`.

The temporary Turbo config at `/private/tmp/canlang-pass10-runner/turbo.json` was made from the production `turbo.json` by appending only those four names to `globalPassThroughEnv`. Its SHA-256 is `cc3f808daa5f54f72bd70953ff36b78c38c2437bd106a10e101868927cfd936f`; production config SHA-256 is `2f908d0dfa6b20fb38ae182a66eeaf564da6007d4404299032dbf3fe5df2d2b4`. The config task graph is unchanged.

The initial JSON dry-run resolved exactly `//#native:compiler:build` (`cargo build --locked --manifest-path compiler/Cargo.toml`) and `//#native:compiler:test` (`cargo test --locked --manifest-path compiler/Cargo.toml`), with test depending on build. It contained no package producer tasks. The prescribed public recipes then ran sequentially, each with `--root-turbo-json=/private/tmp/canlang-pass10-runner/turbo.json --concurrency=1`:

| Recipe | Result | Elapsed |
| --- | --- | ---: |
| `bun run build:compiler` | exit 0 | 11.313 s |
| `bun run test:compiler` | exit 0 | 133.561 s |
| `bun run lint:compiler` | exit 0 | 19.771 s |

The test log contains 50 Cargo test binaries, 1,048 passed and 0 failed. The `actual_completion_engines` contract test passed with the required-engine variable set. The test harness does not print a separate shell witness on success; its source invokes Bash directly and runs the Zsh fixture through Python when both required executables exist. Captured tool versions confirm Bash 3.2.57, Zsh 5.9, and Python 3.14.7 were present. Tool versions and executable hashes are in `toolchain.json`.

`results.json` records exact top-level argv, the environment overrides, exit codes, elapsed times, byte counts, and raw log hashes. `logs/` preserves raw stdout and stderr for each operation. Cargo invocations and test output are included in the public recipe logs. No build output was directed to a new target directory; Cargo used the existing `compiler/target`.

A final narrow `--nocapture` replay executes five integration targets (`string_payload_runtime`, `value_admission`, `catalog_producer_runtime`, `sourcemap_contract`, `typed_bdd`) against the same locked graph. Exit 0: six tests pass, with no skip markers. The raw log explicitly confirms six real CLI/default/testkit string witnesses, the actual catalog emitter/source-dist equality/fresh CLI loader, 29 owner URL cases/15 metadata defaults, and the current artifact/Cloudflare/testkit source-map seam. The two BDD tests assert independently authored emitted bytes; they do not execute a BDD runtime. [Exact command and scope](selected-runtime-results.json), [raw output](selected-runtime.log). This replay resolves optional-body capture uncertainty without repeating the whole suite.
