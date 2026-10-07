# Step 1 — Verified compiler baseline and evidence

**Completed at the declared baseline scope, 2026-10-07.** This executes [audit Step 1](../compiler-correctness-simplicity-audit.md#1-verify-the-starting-evidence-and-freeze-the-scope). Compiler source is frozen at `1fd07722090fe70228a6b661e3c6e136275ca84b`; the observed `851352d5` package-documentation commit has identical compiler contents. No compiler or package implementation changes are made. The next audit steps can use this baseline while respecting the gaps below.

## Pinned inputs

- [Inputs](inputs.json): all 107 tracked compiler paths via the [inventory](compiler-inventory.jsonl), runner/contracts/consumer files, seven exact direct dependency versions/features, full Cargo lock (94 packages, 93 registry checksums), release profile, catalog and 13 runtime package source/manifest/dist identities. Native locked offline metadata and feature-tree commands both exit 0; their exact commands, stream hashes and raw output are retained.
- [Toolchain](toolchain.json): native macOS arm64; Rust/Cargo 1.99, Node 24.21.0, Bun 1.4.2, Bash 3.2.57, Zsh 5.9 and Python 3.14.7. Rustup proxies and actual selected Rust/Cargo executables are hashed separately. No lower-MSRV or other-host qualification follows.
- Catalog: `packages/values/dist/catalog.json`, SHA256 `cd984f375e0d6cbcc2bc6aca5ad5ea5b1b3d3ba9cd17b15ab94e4b15e74ced62`, 59 entries and 15 features; owning source, emitter and built source are pinned. The replay independently confirms source/dist equality and fresh emitted catalog bytes.
- Runtime: workspace resolution is recorded separately from historical installed packages. All 13 original checkout archives still match recorded hashes. Three source manifests differ from packaging-source pins: Cloudflare adds `./runtime/invoke`, UI adds `./csv/grammar`, identity changes imports. Previously present export entries are unchanged. Workspace dependency ranges differ from packed ranges by design. This does not qualify every current or newly added package API.

The 13 `dist` digests use sorted relative-path/file-hash/byte-count records with their exact JSON encoding defined in inputs.json. They pin generated inputs, not source-only reproducibility. The installed scratch tree and five exact historical compiler binary paths are absent; surviving archives do not recreate their original process execution.

## Separate source categories

Gross physical lines include comments and blank lines. Subtract only complete exact top-level `#[cfg(test)]` item spans, retaining production after test modules. There are no flagged nested/complex test attributes or unclassified compiler paths in this snapshot. [Totals and method](counts.json) and per-file intervals retain the replayable count, without maintaining another Rust parser.

| Category | Physical lines | Bytes |
| --- | ---: | ---: |
| Production Rust in `compiler/src` | 69,255 | 2,716,927 |
| Inline Rust tests in `compiler/src` | 3,529 | 129,932 |
| Integration tests and fixtures | 33,040 | 1,314,205 |
| Production build script | 46 | 1,538 |
| Production completion scripts | 256 | 10,860 |
| Cargo manifest and lock | 895 | 23,284 |
| README/convention documents | 764 | 39,801 |
| Static routing/ignore metadata | 62 | 2,486 |

Source production is +136 lines from original `309644a`: the library programme/R01 contributes the previously corrected +130, with +6 from the subsequent recovery repair. That repair also adds 146 integration-test/fixture lines. This separates correctness work from library savings. The programme has not met aggregate production-reduction acceptance. LOC is not a complexity measurement.

## Evidence classification

The [single evidence ledger](evidence-ledger.json) links existing receipts, distinguishes historical/current scope and records uncertain claims. Earlier-pass review is bounded sampling; Pass10's complete saved evidence manifests are rehashed.

| Evidence | Verified scope | Limit or correction |
| --- | --- | --- |
| Pass10 public recipes | Raw exits, 50 harnesses/1,048 passes, no task-cache hits; 156 main and 75 nested consumer manifest entries match | Successful captured tests alone do not prove every optional body executed; three production sources have since changed |
| Pass10 selected replay | Five harnesses/six passes; actual catalog, strings/testkit, URL and source-map bodies execute | BDD's two cases qualify emitted bytes, not a BDD runtime |
| Pass10 releases/workload | Five explicit-success builds, recorded host/profile footprints; saved fixed artifacts agree across 55 map points | Two initial Linux attempts invalid; older incomplete exit records uncredited. Cache-warm timing is not general speed; exact binaries now absent |
| Pass10 consumers | 18 direct processes, two emitted runtime probes and recorded isolated installed provenance | Original CanDo still exits 10 with E3001 and two E3010; original application/Worker/browser acceptance remains open |
| Earlier passes | Saved outcome counts and concrete owner comparisons cross-checked; 23 sampled evidence hashes match | Linux/mode body skips, failed locale candidate and conditional/deferred mechanisms remain explicitly scoped |
| R01 reduction | 62 integration cases, recorded fmt/Clippy exits and 98 equal input pins | Three unit passes are writer-reported without a saved raw run; later source/test changes prevent whole-current qualification |
| Latest recovery/editor owner | Durable quiet log corroborates 1,054 passes/50 harnesses; Clippy-named log contains successful completion | Invocation flags, exits and execution pins are missing from these logs; fmt/startup/actual Cursor claims are reported, not independently raw-qualified here |

The Linux retry receipt's `cargo_finished_seconds` fields are null because its extractor searches stdout; combined raw streams retain 31.07/36.11 seconds. This is incomplete metadata extraction, not a failed build. Original raw receipts are preserved.

## Fresh current witnesses

[Fresh build](fresh-build.json): `cargo build --locked --offline --manifest-path compiler/Cargo.toml`, jobs 1 and incremental off, exits 0. The native debug executable reports commit `851352d5`, matching the recorded source snapshot. Its hash is `d13871c3571bc84ebea8403ea1889352e21fe4aae5c43d2ddb274ef7d48672c5`. The old pre-build debug/release identities are retained separately and receive no freshness credit.

[Selected replay](selected-replay.json): locked offline tests for `catalog_producer_runtime`, `string_payload_runtime`, `value_admission`, `sourcemap_contract` and `typed_bdd`, with `--nocapture`, exit 0: **six passes in five harnesses, zero body skips**. Raw output establishes 59 catalog entries/15 features, six production string witnesses, 29 actual-owner URL vectors/15 metadata defaults, and one fresh 24-point source-map artifact through actual source consumers. BDD remains emitted-byte evidence.

The top-level independent decoder is absent, but the fixture explicitly supports the existing Bun-cache `sourcemap-codec` 1.6.0 copy. Its printed SHA256 matches the separately pinned cached file. No decoder installation occurs. The initial missing-path inference was corrected after tracing that fallback and the executed body; this is warm-cache evidence.

Capture receipts record 107/138 pre/post pin counts and empty changed-input lists; shared per-file hashes are retained. Separate per-run before/after maps were not written, so independent temporal reconstruction is limited. [Independent review](independent-review.json) reproduces current inventory arithmetic, all stream hashes, actual tool pins, 13 dist digests, archives and export comparisons, and accepts this bounded packet. A separately labeled [post-replay observation](post-observation.json) matches all 139 available recorded input hashes; it does not fabricate an earlier end snapshot.

## Exit and follow-on gaps

Step 1 establishes concrete inputs, corrected category measurements and a classified evidence baseline. No whole-suite rerun, GUI run, current installed package/original application acceptance, release rebuild, cold-build/install, or additional host qualification is claimed. Those gaps block only claims/packets that depend on them. No merge or living-plan checkpoint advancement occurs.

Luna medium owns repeatable inventory/counting; Sol low reviews selected earlier/owner receipts; Sol medium independently reviews final raw evidence and the new baseline. Existing target/caches are reused. Root owns integration/Git, preserves concurrent package work, and commits pins separately from the evidence ledger.
