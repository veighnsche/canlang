# Pass5 isolated serialization dependency/profile qualification

Baseline: `5cf27d6632ed0c6e61befd3ffe7d05d18931dac2` compiler tree. Current: final Pass5 compiler snapshot, including the final JS string adapter/private unit test and CLI fix regression. Both snapshots omit `.git`; release binaries report commit `unknown`. The local, explicitly authorized `examples/ExpenseFlow.can` sibling fixture is hash-pinned for library acceptance. No package code was copied or built.

Source inputs: `baseline-source-sha256.json`, `current-source-sha256.json`, `fixture-sha256.json`, `source-delta.json`. Exact commands: `commands.json`, `linux-build.sh`. Both builds use the unchanged compiler release profile: `strip=true`, `opt-level="z"`, `lto=true`, `codegen-units=1`, panic unwind.

Dependencies: `locks.json`, `features.txt`, `baseline-features.txt`, `current-native-metadata.json`, `added-licenses.json`, `profile-data.json`. Current lock has 62 registry packages versus baseline 58. All 62 archives were SHA-256 verified against Cargo.lock before offline qualification in the isolated public Cargo cache (`crate-cache-checksums.json`). Most came from native ~/.cargo; linux-raw-sys used the checksum-verified existing Pass4 public cache. Added packages: itoa1.0.18, memchr2.8.3, serde_json1.0.151, zmij1.0.23. Their licenses offer MIT-compatible choices. New direct Serde dependency remains pinned1.0.229 with std/derive and defaults disabled; serde_json defaults disabled, std/raw_value enabled. Rust1.99.0 is the executed compiler; no lower MSRV qualification is claimed.

Native host: Darwin arm64; native-host.json records exact OS/Rust/Cargo. Native release logs and native-sizes.json hold measurement evidence. Linux: local Docker Desktop x86_64 emulation, Debian13.7, same Rust1.99.0, pinned public image rust@sha256:24e632c09342c20abf8312cf4f61430a911c01ed3a5e4c02b87292b1c39c5273, amd64 child458b145eb2406e832adc9c9536d487c5d264401a4ce63adbeced3fe91292616c. Image identities/host: linux-image.json, linux-amd64-image.json, linux-host.txt. The previously recorded image was absent locally and public layers were downloaded by pinned digest. Project/fixture data stayed on the local host; build/test containers used --network none, --pull=never and only isolated temporary source/cache mounts.

Checks: offline locked release baseline/current for both hosts. Linux current full library and all typed_* output fixtures/CLI tests are selected by linux-build.sh. Runtime package consumer tests explicitly skip in this compiler-only profile; the native repository consumer runs are separately owned by root. No Windows, native Linux hardware, lower MSRV, or full Linux integration suite is claimed. JSON input parsing/accessors and source-map coordinate/codecs remain outside the migration.

## Final results

| Host | Baseline stripped bytes | Pass5 stripped bytes | Delta |
| --- | ---: | ---: | ---: |
| macOS arm64 | 2,117,216 | 2,150,544 | +33,328 (+1.574%) |
| Linux x86_64 emulated | 2,905,600 | 2,947,352 | +41,752 (+1.437%) |

Both host releases passed, use matched unknown-Git stamps and the unchanged stripped release profile. Final snapshot parity with the live compiler is verified in `live-snapshot-parity.json`. Native suite/runtime consumers were not repeated here; root owns their separate qualification.

Linux full library: **109 passed**, unskipped. Twelve typed output targets: **33 harness passes**, of which **30 tests executed** and **three package-consumer tests explicitly skipped** for absent built packages (`current-linux-typed.log`, `current-linux-runtime-consumer.log`). Real CLI diagnostic, fix, explain and policy fixtures ran successfully. No fabricated package results replace skipped consumers.

Two initial Linux build containers exited137 without a Rust diagnostic. Docker event history was empty and unrelated existing containers had recently restarted; the cause is unconfirmed, not labeled OOM. The third retained attempt used one Cargo job and completed release, library and typed tests with exit0/OOMKilled=false. No Docker settings/services were changed. Only the completed qualification container was removed after recording its state. The prior public image pull downloaded pinned public layers only; no source was uploaded.

Machine-readable results and binary SHA-256 hashes: `results.json`, `native-sizes.json`, `*-linux-sha256.txt`. Exact resumed command body: `linux-resume.sh`; host/image metadata and logs retained alongside this receipt.
