# Experimental native Cargo discovery probe

Executed 2026-10-06 in isolated scratch copies. Primary binary: **Turborepo 2.11.7**, SHA-256 `b10e28233aabac29e5e8f6c95f438b3407fc1cd5706305b0e215aa17602aa9ce`. The parent installed exact 2.11.0 and latest 2.11 patch 2.11.7; the latter is the primary test version, with initial-release comparison results separately labelled. Binary envelopes preserve paths/hashes, and `version.json`/`old-version.json` preserve actual version output.

## Inputs and isolation

`probe.py` copies all currently present Git-tracked package/compiler source files and root package/lock/config inputs into `/private/tmp/canlang-turbo-probe-20261006.89738Q/native/actual`, omitting `target`, `dist` and `node_modules`. It preserves tracked generated values binding inputs, all 13 JavaScript owners, standalone compiler, private values semantics/bindings Cargo workspace, work-kernel Cargo owner, nested preparation and loader-smoke crates. `actual-copy.json` records source HEAD, copied paths and absence of root Cargo.toml. Native discovery uses scratch `turbo.json` with the installed-schema-supported `futureFlags.experimentalCargoWorkspaces=true`. Product manifests and code were untouched.

All native operations are list/dry-run/Cargo metadata. No actual Rust compilation, toolchain installation, backend selection, publication or preparation port work occurred. Cargo metadata for the dependency-free control creates its isolated lockfile. `CARGO_NET_OFFLINE=true`, telemetry disabled and update notifier disabled were set. The wrapper logs attempted Cargo argv and adds `--offline` to metadata before executing the available Cargo; this interception is explicit, not claimed to be Turbo's original command. The denied wrapper returns 127 with a fixed message. `cargo-calls.jsonl` records all interceptions. Exact command/stdout/stderr/exit/cwd envelopes are separate JSON files. Scripts/configuration and synthetic fixture sources are retained here. Help and installed npm schema were inspected before defining flags; later commands also use `--skip-infer`.

## Expected versus discovered

| Case | Probe expectation | Observed result |
| --- | --- | --- |
| Actual repository shape, no root Cargo.toml | Determine whether nested/standalone crates join JS graph | 13 JS identities only; no compiler, values Rust members, preparation or loader-smoke identities. Work-kernel remains its JS identity. Both 2.11.7 and 2.11.0 agree. |
| Actual native filter `canlang-compiler` | Discover crate or reject absent identity | Exit 1: package not found. |
| Actual TS-only filter with Cargo unavailable | TS metadata remains usable | Exit 0; only contracts TS build command. No Rust build attempted. |
| Root virtual Cargo control, no workspace name | Establish minimal native discovery requirements | Exit 1: root `[workspace.metadata] name` required. These failures are retained, not silently corrected away. |
| Named root Cargo control | Positive native discovery, member dependency, mixed owner shape | 6 identities: 2 JS, 3 crates, named Cargo workspace. Both tested releases agree. |
| Same complete control, root Cargo.toml removed | Determine discovery of standalone nested manifests | Only 2 JS identities. No nested native members discovered. |
| Native app filter in named control | Derive task and app-to-library edge | `cargo build --package=probe-app --locked`, depends on `probe-core#build`. |
| Unfiltered native verification | Inspect aggregation | One `probe-native-workspace#check`: `cargo check --workspace --locked`; JS check placeholders are `<NONEXISTENT>`. |
| Dual JS/Cargo directory with different identities | Inspect ownership/duplicate handling | Both `@probe/dual` and `probe-dual` listed at `packages/dual`; individual filters select their separate JS/Cargo commands. |
| Dual directory with identical JS/Cargo identity | Inspect collision handling | Exit 1: duplicate workspace identity; CLI requires renaming. No automatic merging. |
| Named root control TS-only execution, Cargo unavailable | Prove filter can avoid requiring Cargo | Synthetic JS command executes successfully; remote caching disabled. |
| Named root control native filter, Cargo unavailable | Prove native task still requires Cargo metadata | Exit 1: controlled `cargo metadata` failure. |

The no-root cases therefore do **not** qualify native discovery for this checkout's existing ownership topology. The positive control proves the feature flag is active and native support can work for a named repository-root Cargo workspace. It does not justify introducing such a workspace into Can: `C04.graph` explicitly preserves the standalone compiler and forbids that change. Go/Python controls below are synthetic scratch fixtures only; no existing project was converted and no tool upgrade was performed.

## Synthetic Go/Python controls

These fixtures are deliberately unrelated to existing Can projects. Go reports **1.27.1 darwin/arm64**; uv reports **0.5.9**. Their raw version envelopes and exact intercepted tool arguments are saved. Go is constrained by `GOTOOLCHAIN=local`, `GOPROXY=off`, `GOSUMDB=off` and scratch cache directories; uv uses `UV_OFFLINE=true`, `UV_PYTHON_DOWNLOADS=never` and a scratch cache. No language dependency download or native build occurred.

| Synthetic case | Expected probe | Observed |
| --- | --- | --- |
| Root go.work with two local modules | Discover modules with no downloaded dependencies | Initial app require without module-local replacement failed read-only module lookup under `GOPROXY=off`. Initial failures preserved. |
| Same Go shape with `replace ... => ../core` | Prove local-only discovery/task edge | Exit 0: `app`, `core`, `go-workspace`; `app#build` is `go build .`, depends on `core#build` (`go build ./...`). Both default uncached; app warns possible source/output overlap, core warns no stable library outputs. |
| Root Python/uv workspace with root project name | Determine workspace identity requirement | Exit 1: explicit `[tool.turbo] name` required. |
| Python workspace with explicit Turbo name | Discover members and assess old uv compatibility | Exit 0 lists app/core/workspace. Warnings: uv 0.5.9 lacks `uv workspace metadata --frozen` and `uv python find --resolve-links`; conservative hashing and disabled task caching. |
| Python build/check dry-run | Inspect proposed commands without execution | Build yields no tasks because these stdlib-only synthetic project manifests declare no build backend. Check yields uncached `uv check --frozen --all-packages`; that command was not executed or validated against uv 0.5.9. |

The Python result is limited discovery with explicit compatibility failures, not a supported/cached execution path. No Python dependency-aware graph claim follows from listing names, and the Go result does not create or qualify a future Can Go project. Raw CLI success must not hide stderr warnings or empty task lists. `language-calls.jsonl` records Go/uv invocation arguments; the commands remain offline. All initial and adapted fixture inputs are saved separately.

## Task/cache observations and limits

The root control's unfiltered build selects native entrypoints and their dependency libraries; it does not automatically build every library crate. The app's default output is `../../target/debug/probe-app`. Native library tasks default uncached and emit warnings that their artifacts lack stable outputs. Distinct JS/native identities at the same directory remain separately configurable; identical names are rejected. These are observed metadata/task defaults, not proof of correct cross-language artifact/cache restoration.

No native command execution, host portability, WASM target/profile/glue selection, actual compiler commit-stamp cache keys, release binary modes, source-map/declaration consistency, installed asset integrity, package boundary enforcement or C05 performance/parity was verified. Root default native `build` is not a substitute for values' locked release-WASM/bindgen staging lifecycle, work-kernel's explicit WASM command, or preparation's CI prerequisite receipt.

## Bounded recommendation and fallback

Use the repaired Bun/package task graph and explicit command adapters for current standalone/nested native owners. Keep native dependencies authoritative in their Cargo manifests; an adapter does not require fake npm identities for each crate. For this topology, native discovery remains unsupported by the tested configuration, rather than an untested assumption. Re-evaluate only against a pinned future implementation that can preserve the existing ownership layout.

Before any adapter-orchestrated cutover, verify uncached/current commands and restoration after deleting outputs: values generated hashes/staging and catalog; CLI executable modes; JS/declaration/map outputs plus consistent `.tsbuildinfo`; compiler Git-commit version; preparation private target and `CAN_PREPARATION_BIN` receipt; release stamp/dist inventory. Source, lock, toolchain, target/profile and relevant environment mutations must invalidate corresponding results. Producer failure must prevent dependent consumers. Retain the previous Bun/manual path on any failed gate. Library caching remains disabled until stable output restoration is demonstrated.

This probe contributes only orchestration/discovery evidence to `C04.graph`. `C04.values-assets`, `C04.work-assets`, supported installed-native release and `C05.complete` remain separate. `C04.native-release`/P09 human preparation HOLD is not resumed or satisfied by these results.

## Reproduction

After restoring the documented scratch tooling installations, run `python3 implementation/package-boundaries-probe/evidence/native/probe.py`, then `named-control.py`, then `filtered-execution.py`, `go-python-controls.py` and `go-python-followup.py` from the checkout. Their scratch paths are fixed for this saved run. Raw envelopes are overwritten on replay; preserve this directory elsewhere first if historical comparison is needed. `summary.json` is a compact derived task view; raw JSON files retain authoritative stdout/stderr.
