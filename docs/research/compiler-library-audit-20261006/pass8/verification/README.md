# Pass 8 native verification

The final codec/artifact implementation passes the full native compiler suite: **1,040 tests in 49 harnesses, zero failures or ignored tests**. All-target Clippy with `-D warnings` passes. The final actual-consumer regression passes again after the intermediary source-content optimization, with no dependency/catalog skip. Rust/Cargo 1.99 and Node 24.21.0 were executed.

Commands, from the repository root:

```sh
cargo check --offline --manifest-path compiler/Cargo.toml
cargo test --offline --manifest-path compiler/Cargo.toml
cargo clippy --offline --manifest-path compiler/Cargo.toml --all-targets -- -D warnings
cargo test --offline --manifest-path compiler/Cargo.toml --test sourcemap_contract -- --nocapture
```

`native-full.log`, `clippy.log` and `consumer-final.log` save outcomes. `results.json` records final source/consumer pins, parsed harness totals and retained scope. The permanent consumer test uses an independent arithmetic VLQ decoder and fixed byte/CRLF expectations, then actual current source implementations of artifact parse/load, lookup, invokeCallable and failure-location reporting. Its synthetic emitted throwing function reports `coordinate.can:1:7`; a separately fresh CLI-compiled artifact has one module and 24 mapped generated rows with fixed frontend anchors. These are separate witnesses: the synthetic invocation does not claim complete frontend lowering of a throwing source program.

[Independent review](../review.md) found no actionable findings, including reversed/duplicate source identities, collision-like authored paths, repeated/empty names, missing sources, controls/null contents and invalid alphabet/width/delta boundaries. Browser navigation, host-remapped original frames, deployed workerd and broader frontend constructs remain outside this profile. Original source byte coordinates and the separate LSP UTF16 owner are retained.

`formatting-comparison.json` records 83 whole-tree legacy formatting hunks before and after, with zero additions. Changed Rust files were formatted; the entire tree was not reformatted. Scoped `git diff --check -- compiler` passes.

After completed native processes, escalated filtered process inspection and empty open-file checks, only `compiler/target/debug/incremental` was reclaimed. `storage-cleanup.json` records 6,247,294,419 logical regular-file bytes removed and free space rising from 15,974,400,000 to 20,316,160,000 bytes. Source, Git, binaries, dependency caches, shared release/Linux targets and unique evidence were retained. Linux host qualification and final storage checks are recorded separately in the host receipt.
