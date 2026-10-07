# Pass 9 frozen Linux correctness qualification

The frozen C09I-1 ICU numeric admission repair and P09-1/P09-2 inverse-position/lexical-path repairs pass on the existing pinned offline Linux compiler profile: **68 executed test bodies, 68 passed, 0 failed, 0 ignored, 0 in-body skips**. The Docker invocation exited 0 on its first test attempt. This receipt covers these compiler contracts; root separately owns the native suite and actual public/runtime-owner qualification.

| Target and selection | Passed | Filtered out |
| --- | ---: | ---: |
| `--test check icu_` | 4 | 33 |
| `--lib lexical_normalize` | 2 | 124 |
| Complete `--test docs` | 30 | 0 |
| Complete `--test ide` | 32 | 0 |
| Total | 68 | 157 |

The 157 filtered entries belong to the two deliberately focused selections, and were not executed. The full IDE/docs suites use test-owned catalog fixtures and have no in-body skips. Shell completion engines and package-dependent runtime/catalog suites were not run by this receipt; no claim about an engine being absent from the image or a skipped catalog case is made.

The ICU cases execute the fixed eight-way numeric matrix through source and live translated literals, unsupported-style precedence, decoded source anchoring, and existing grammar/selector controls. Position cases cover bare EOF/internal CR, CRLF, UTF16/nonBMP surrogate interiors, clamping, empty/trailing-LF/missing lines and roundtrips against the unchanged source LineIndex. The private lexical tests execute 13 fixed assertions including retained leading parents and the existing literal-parent-above-root policy. The complete public docs suite includes missing-relative-root parent preservation, relative/absolute spellings, real/missing external paths, Unix symlinks and moved-checkout identities. No broader relative-root identity or missing-suffix symlink policy is qualified by these repairs.

## Frozen inputs and tools

`snapshot.json` records snapshot completion at **2026-10-07T02:39:19.259555+00:00**, HEAD context `29b70a69c76acb311dd6bd7ea37a699a8c02bac6`, and the actual working inputs. `source-manifest.json` pins **112 files / 4,247,000 bytes**. The snapshot contains the compiler excluding target/.git/.DS_Store, ExpenseFlow and TeamTasks, the two editor include_str! LSP fixtures, and the analysis include_str! URL vectors. Full packages and full editor consumer are excluded. `source-snapshot.tar.gz` preserves the same inputs for replay; its bytes/hash are in `storage.json`. Snapshot/live parity after all tests was clean at 2026-10-07T02:41:21.467700+00:00, with no newly appearing compiler inputs (`source-parity.json`).

The executed image pin is `rust@sha256:24e632c09342c20abf8312cf4f61430a911c01ed3a5e4c02b87292b1c39c5273`, with `--pull=never --platform linux/amd64 --network none`. Actual tools reported rustc **1.99.0** commit `b940084d7eb6a299eb4bfeb8e34901bc051e7ac4` (LLVM 23.1.1), Cargo **1.99.0** `5f94df478`, host `x86_64-unknown-linux-gnu`, Debian **13.7 trixie**. Exact tool output and each test body appear in `linux-tests.log`.

`Cargo.toml.txt` and `Cargo.lock.txt` are exact frozen copies and match Pass8 byte-for-byte. No dependency was added or changed. This qualification establishes neither a lower supported Rust version nor performance or binary-size effects.

## Commands, setup and storage

`commands.json` records the exact Docker argv; `linux-tests.sh` records all actual inner commands. The container mounts `/private/tmp/canlang-pass9-profile` read-only as `/profile`, reuses `/private/tmp/canlang-pass5-profile/cargo-home` as `/cargo-home` and the existing `/private/tmp/canlang-pass5-profile/current-linux-target` as `/linux-target`. All three Cargo calls use `--offline --locked`, `CARGO_BUILD_JOBS=1` and `CARGO_INCREMENTAL=0`.

Replay by restoring `source-snapshot.tar.gz` beneath `/private/tmp/canlang-pass9-profile`, copying `linux-tests.sh` into that directory, then executing the argv in `commands.json`. `run-linux.py` is the recorded runner, `snapshot.py` records how the original frozen inputs were acquired, and `verify.py` parses test totals and checks snapshot/live hashes. Re-running the snapshot helper deliberately refuses to overwrite the retained snapshot.

The initial sandboxed Docker image inspection could not connect to the local socket; an authorized escalated read-only inspection succeeded and confirmed the image pin. `host-setup-observations.json` preserves that setup limitation. There were **no test failures/retries**, image pulls, index/cache recovery steps, package installs, new target directories, Docker service/settings changes, or image pruning. The host had **24 GiB available before work**. `storage.json` records the final disk observation; shared targets/cache and unique baseline evidence were retained. This lane writes only `pass9/profile/**` and task-owned temporary snapshot inputs.
