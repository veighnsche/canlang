# Pass 4 — qualified hash and owned-file packets

Both bounded packets are implemented and accepted independently. The urgent file permission repair landed first as `80868ad`; the maintenance hash substitution followed as `5cf27d6`. No hash defect is claimed. Preserve the existing pass sequence: no new prerequisite or whole-repository audit is needed.

| Packet | Implementation / outcome | Acceptance |
| --- | --- | --- |
| [C04F files](files/README.md) | One destination-local owned stage for fmt/docs, written through its open handle. Existing regular-file permissions are restored after writing; changed link entries follow deliberate compatibility policy. Reproduced `0600` widening is repaired. | Separate file-only releases, nine real CLI witnesses on macOS and Linux; eight controlled failure/concurrency witnesses on Linux and included in 24 CLI unit tests on the independent macOS snapshot. |
| [C04H hash](hash/README.md) | Stable exact-byte/lowercase `sha256_hex` delegates to sha2; one hash implementation. Source, revision, migration and stale-fix consumers remain unchanged. | Old and new implementations pass 16 independent answers; six source-module tests pass on both hosts; five downstream targets pass 102 tests. |

## Integrated verification and pinned inputs

[Full compiler suite](full-suite.log): **967 passed / 0 failed / 0 ignored** across 32 test targets, macOS aarch64 Rust 1.99. [Clippy](clippy.log): all targets with warnings denied pass. `cargo fmt --check` still fails on the same **88 baseline hunks**, with no new normalized formatting hunk; [comparison](fmt-comparison.json) normalizes checkout prefixes, diagnostic line numbers and trailing spaces from archival logs.

The compiler/catalog/package-runtime comparison pins [677 baseline inputs](baseline-input-manifest.json) and [678 final inputs](final-input-manifest.json). Expected compiler changes are manifests/lock, CLI, source hash and the new file-process witnesses. One additional pinned TS source (`packages/values/src/wire.ts`) changed concurrently under the package agent; compiler work did not touch it. The built catalog/runtime inputs used by the compiler tests remain byte-identical, and saved current/final pins show no subsequent input drift. No package source/build was staged in these compiler commits.

Dependency integration is locked/offline: tempfile 3.27.0 with only explicit getrandom/defaults off, sha2 0.10.9/defaults off and existing url 2.5.8/std. The lock grows from 37 registry packages to 50 file-only, 47 hash-only and 58 combined; libc/cfg-if overlap. All 58 public archive checksums were verified before preparing the isolated Linux cache. [Published manifest metadata](dependency-manifests.json), [combined features](features.txt) and separate packet locks/profiles record target gating, licenses and declared MSRV caveats. Project Rust 1.99 remains the executed toolchain.

## Host and release comparison

Independent packet copies pin exact source/lock inputs. macOS runs natively. Linux uses a pinned Debian Rust 1.99 amd64 image locally under emulation with networking disabled, isolated Cargo/source/targets and public checksum-verified crates. No remote private-source upload occurred. Each packet saves its recipe, source manifest, tool/OS/artifact identities and raw results; Linux qualification here is packet-specific, not a complete compiler or installed-runtime qualification.

| Isolated release change | macOS aarch64 | Same-image Linux x86_64 |
| --- | --- | --- |
| Owned file adapter | +16,768 bytes (0.80%) | +22,440 bytes (0.78%) |
| sha2 adapter | +16 bytes (0.0008%) | +5,376 bytes (0.187%) |

The matched comparisons retain existing stripped opt-level-z/LTO/one-codegen-unit/unwind settings and isolated `unknown` Git identity. No throughput or universal footprint improvement is claimed. SHA-2 0.11.0 is published but was not qualified in this bounded replacement; the receipt explicitly records the selected 0.10.9 branch and remaining backend/version gates.

## Policies and remaining limits

[Three verified-context JEV requests](consultation/assessment.md) choose file policy with balanced alternatives. Low-confidence symlink advice and the 2–1 new-output privacy split were investigated against released behavior. Changed symlink/hardlink writes replace only the requested entry; peers retain old bytes. New docs creation follows caller umask, existing regular targets preserve modes, readonly entry replacement remains governed by OS directory permissions. Independent review reports no blocking issue under this policy.

Linux establishes and preserves special `04750` mode. macOS strips the special bit during fixture setup and explicitly leaves that subcase unqualified there; mandatory private/ordinary/readonly mode witnesses pass. Docs witnesses use the real CLI/catalog and explicit producer stub, not installed rendering.

Metadata observation begins at writer entry after initial read/render; checks detect observable changes with a residual interval before persist. Parent directories are trusted. Owned cleanup is best effort, and abrupt termination/noclobber fallback errors can leave names. Atomic per-file replacement does not prove owner/ACL/xattr/timestamp/inode preservation, all-operands transactions, sync or crash durability. Windows, alternate MSRVs, adversarial directory swaps, exhaustive filesystem/hardware backends and installed runtime remain unqualified.

## Delegation and handoff

Sol low owns the hash implementation and bounded review. The requested Sol-medium file worker was refused by the dispatcher thread limit; root completed that bounded writer and reused an existing inherited-model agent for independent read-only review. No invented model attribution, escalation benefit or measured savings is claimed. Root exclusively integrated Cargo and scoped Git/DECISIONS changes, preserving the concurrent package work.

The next independent work can continue with Pass 5's declared serialization packet after its own contract is frozen. Deferred locale qualification remains a separate packet; it does not block this completed pass. No merge or living-plan checkpoint advancement is claimed. [Machine receipt](verification.json) records exact status, input classifications and limitations.
