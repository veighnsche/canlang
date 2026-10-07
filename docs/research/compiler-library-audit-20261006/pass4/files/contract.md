# C04F caller contract and acceptance boundary

## Closure, owners and original acceptance

One defining writer owns `compiler/src/cli.rs`: `run_fmt` and `run_docs_with_platform` are the only production callers of `write_file_atomic`; both now use the same destination-local owned staging helper. `compiler/Cargo.toml` / `Cargo.lock` have one root integrator. Permanent outcome witnesses live in `compiler/tests/file_ownership.rs` and `cli::replacement_tests`.

The original Pass 0 [file/hash witnesses](../../pass0/witnesses/files-hashes.json) reproduce `0600` source becoming `0644` under umask `0022`; this is the urgent defect. The predictable PID/sequence temp pathname and reopened pathname ownership are replaced by `tempfile::Builder::tempfile_in` and writes through its owned open handle.

`fmt` reads all inputs and parses/formats all before any write. Input failures remain E7002/exit 2; parse failures keep the aggregated diagnostics/exit 10 and no source writes. `--check`, stdin filtering and silent successful file writes remain unchanged. Changed operands are written in order, and a later failure can leave earlier operands completed. Write failures remain E7007/exit 2. Equal initial bytes stay untouched; an earlier write or concurrent writer that already produced the complete intended bytes is also a no-op, preserving repeated operands/aliases.

`docs --out` still rejects `.can` destinations and literal/canonical input aliases before rendering. Successful complete renderer UTF-8 output uses the same helper; write failures remain E7007/exit 2. The renderer interface is retained. Docs process witnesses use the real compiler/catalog and an explicit producer stub, not the installed renderer.

## Classified compatibility matrix

| Boundary | Classification | Chosen outcome / witness |
| --- | --- | --- |
| Existing regular file | Correctness repair | Keep complete formatted/rendered bytes and captured `std::fs::Permissions`, including reproduced `0600`. Child umask must not narrow `0640`/`0750`. |
| Readonly regular file | Intended compatibility | Parent-directory permission may allow replacement; final `0444` remains. |
| Special permission bits | Required when established by host | Restore after writing. Linux establishes/runs `04750`; macOS host strips fixture bits at setup and reports that subcase unqualified. |
| Changed final symlink | Deliberate existing policy | Replace requested link entry. Readable regular target supplies captured mode; target inode/bytes stay unchanged. |
| No-op symlink | Intended compatibility | Keep the symlink and inode; no staging/replacement. |
| Hardlink | Deliberate existing policy | Replace only requested name with a new inode; peers retain old bytes/inode. |
| Missing docs destination | Intended compatibility | Unix ordinary `0666 & !umask` creation; `0027` yields `0640`. Use noclobber so a new concurrent entry is not silently overwritten. |
| Dangling/dir-target docs symlink | Deliberate entry policy | Replace link itself, leave missing/directory target untouched, use ordinary creation mode. |
| Existing directory output | Existing failure mapping | Persist fails E7007; directory stays and owned staging is removed on tested hosts. |
| Partial staging error | Cleanup/failure qualification | Controlled `WriteZero` before replacement keeps original bytes and leaves no stage. It is not a full-disk or crash experiment. |
| Observable concurrent edits | Selected bounded protection | Changed content, creation, permissions, entry inode or symlink-target mode during staging fails; concurrent bytes/entries survive. |
| Whole invocation / durability | Separate limits | Per-file replacement only; no all-operands transaction, sync, ownership/ACL/xattr/timestamp/inode preservation or crash durability. |

## Candidate and supported profile

Pin `tempfile = 3.27.0`, defaults disabled, `getrandom` enabled; keep random-name exclusive creation and no nightly feature. The candidate is MIT OR Apache-2.0, edition 2021, advertised crate MSRV 1.63. Its added locked closure includes getrandom 0.4.3 with declared Rust 1.85; project rustc 1.99 is the executed toolchain. Do not infer the closure minimum from the direct crate's MSRV. All added licenses offer MIT/Apache-compatible choices. Target-gated Windows/WASI packages are pinned, not executed.

Published [NamedTempFile](https://docs.rs/tempfile/3.27.0/tempfile/struct.NamedTempFile.html) and [Builder](https://docs.rs/tempfile/3.27.0/tempfile/struct.Builder.html) APIs plus cached source establish creation, `persist`, `persist_noclobber`, permissions and error ownership. On error, retained owned stage drops after propagating the IO error. Cleanup is best effort; abrupt termination can leak a name, and noclobber fallbacks can leave an extra hardlink if unlink fails. Recorded normal/failure witnesses do not prove every filesystem fallback.

Claimed execution: macOS aarch64 and local Debian Linux x86_64 under Docker emulation, Rust 1.99, offline locked Cargo and network-disabled Linux container. Parent directories are trusted. Metadata observations start at writer entry, after initial input read/render; checks catch observed changes but cannot establish all history since the read. Final recheck and persist are separate operations. No Windows or adversarial directory-swap qualification.

Consequential policy choices use the [verified-context consultation and disagreement assessment](../consultation/assessment.md). Their low-confidence symlink choice and split missing-output choice were investigated against released behavior rather than treated as an API oracle.
