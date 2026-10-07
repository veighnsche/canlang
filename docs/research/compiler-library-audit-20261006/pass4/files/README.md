# C04F owned replacement and source permission repair

**Accepted bounded file packet.** Keep the existing fmt/docs adapters and replace predictable temp path allocation with destination-local `tempfile` ownership. Write complete bytes through the open handle; restore captured regular-file permissions after writing; persist only after checking observed destination metadata and fmt expected bytes. Both production callers use one staging path.

The [caller contract and compatibility matrix](contract.md) and [three JEV consultations](../consultation/assessment.md) record deliberate symlink/hardlink, readonly, new-output and race policies. The released changed-write link policy remains requested-entry replacement: peer names retain old bytes. New docs outputs use ordinary umask-filtered creation; existing regular targets retain mode. This repairs the independently reproduced `0600`→`0644` defect without claiming owner/ACL/xattr/durability preservation.

## Executed acceptance

- macOS aarch64, rustc/cargo 1.99.0: independent file-only release and all nine [real-process tests](independent-process-tests.log) pass. Regular/private/readonly/umask modes, changed/no-op links, repeated operands/aliases, missing fmt input E7002, new/existing docs outputs and E7007 directory failure are checked through the real CLI. The actual catalog is used, with an explicit docs producer stub; installed rendering is outside this packet.
- Linux x86_64: same independent file-only source/lock profile, pinned public Rust image, local emulation, `--network none`, isolated Cargo cache, locked/offline build. [Eight controlled failure/concurrency tests](linux/failure-tests.log) and [nine real-process tests](linux/process-tests.log) pass. Source pins are in [linux-source-manifest.json](linux-source-manifest.json), tool/OS/binary identities and raw logs in `linux/`, recipe in [linux-run.sh](linux-run.sh).
- Linux establishes and preserves the `04750` special-mode fixture. macOS strips that bit during fixture setup; its log explicitly skips that subcase, so it does not qualify special-bit preservation there. Ordinary `0600`, `0640`, `0750`, `0444` setups are mandatory and pass on both recorded hosts.
- Failure witnesses independently assert old/concurrent bytes and directory entries survive partial staging `WriteZero`, stale input, destination creation/content/mode/inode changes, symlink-target permission changes and persist-to-directory failure. Staging is absent after the tested handled errors. Controlled IO failure is narrower than a physical full-disk or crash experiment.
- Independent [read-only review](independent-review.json) reports no blocking issue under this selected policy. The shared integrated snapshot additionally passes the complete compiler suite and Clippy; the independently accepted file-only snapshot excludes the pending hash adapter.

The initial process run failed from witness setup errors (unsupported `--platform-bin` flag and a special-mode fixture not established on macOS), preserved in [process-initial.log](process-initial.log). Correcting the witness to use the real `CAN_PLATFORM_BIN` interface and explicitly checking fixture modes made all tests pass. These were not compiler failures.

## Dependency / release cost

Pin `tempfile = 3.27.0`, defaults off, `getrandom` enabled. [Dependency metadata](dependency-profile.json), [feature tree](features.txt) and isolated [manifest](integrated-Cargo.toml)/[lock](integrated-Cargo.lock) qualify the file-only closure. This adds 13 locked registry packages to the existing 37; some are target-gated. Direct crate advertises MSRV 1.63; added getrandom declares 1.85. Only project Rust 1.99 is executed. Licenses offer MIT/Apache-compatible choices; no new Windows/alternate-toolchain claim.

[Matched release footprint](release-footprint.json): macOS 2,100,432→2,117,200 bytes (+16,768; 0.80%); same-image Linux 2,877,648→2,900,088 bytes (+22,440; 0.78%). Profiles use the compiler's stripped `opt-level=z`, LTO, one codegen unit, unwind settings and isolated `unknown` Git identity. Absolute artifact hashes are recorded. No throughput or installed-runtime improvement is inferred.

## Practical limits

Metadata observations start at writer entry after input read/render. Checks detect observable changes, with a remaining interval before final persist; they are not compare-and-swap or an all-history-since-read guarantee. Parent directories are trusted. Replacement can change inode, owner, ACL, xattrs and timestamps; per-file atomic replacement does not imply an all-operands transaction or crash durability. Neither file nor directory is synced. Drop cleanup is best effort; abrupt termination and platform noclobber fallback failures can leave names. No Windows host, adversarial directory swap or exhaustive filesystem fallback is qualified.

Delegation followed the researched Pass 4 setting: Sol medium was requested for the file writer, but the dispatcher refused another worker at its thread limit. Root completed that bounded writer; an existing inherited-model agent performed independent read-only review. No invented low-cost/model attribution or measured cost saving is claimed. Hashing's Sol-low worker and separate release gates did not delay this permission repair.
