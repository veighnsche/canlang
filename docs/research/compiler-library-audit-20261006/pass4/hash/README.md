# C04H SHA-256 qualification

**Accepted bounded hash packet.** Keep the stable adapter and replace the handwritten compression/padding with qualified sha2. Root integrated the dependency and compared representative release footprints before accepting. Model allocation: Sol low, as specified by the Pass 4 allocation. No escalation or JEV decision needed: this preserves an already released byte contract.

## Contract and evidence

`sha256_hex(&[u8]) -> String` remains public, hashing exact input bytes into 64 lowercase hexadecimal characters. Source APIs and line-index behavior are unchanged. The handwritten implementation and candidate both passed all 16 independently calculated Python `hashlib.sha256` answers; this change addresses maintenance ownership, not a demonstrated hash bug. Empty/abc/long NIST-style known answers, arbitrary binary bytes, UTF-8, LF versus CRLF, padding boundaries 55/56/63/64/65/127/128/129 and million-byte multiblock input are included. Existing tests remain and two byte-contract tests are added.

Run `python3 docs/research/compiler-library-audit-20261006/pass4/hash/qualify.py` from the repository. It compiles baseline from pinned `0104b04` and current compiler adapter only in `/private/tmp`, preserves raw results, and records resolved dependency metadata and scratch lock. `vectors.json` is the independently generated expected table. The current run used rustc 1.99.0 on the local host. Baseline results agree with Pass 0 hash witnesses; no normalization or stale identity policy changed.

## Dependency recommendation

`sha2 = { version = "=0.10.9", default-features = false }`

The cached 0.10.9 manifest and README establish MIT OR Apache-2.0, edition 2018, advertised crate MSRV 1.41, and reexported `Digest`/`Sha256` one-shot API. No direct digest or hex dependency is needed: LowerHex on the digest yields the existing string representation. Optional asm, oid, compress, std and force-soft features are disabled. Scratch Cargo resolved ten dependency packages; `dependency-profile.json` records versions/licenses. Maximum declared transitive rust-version is libc 1.65; missing declarations prevent claiming a proven full-closure minimum. Only project rustc 1.99.0 was tested. All closure licenses are MIT/Apache compatible. Release scratch used the same strip/opt-level z/LTO/codegen-units 1 settings as compiler; its fixture binary is not a compiler footprint estimate.

[Official 0.10.9 crate documentation](https://docs.rs/crate/sha2/0.10.9) confirms the SHA-2 family/API and optional assembly dependency. [Official current release documentation](https://docs.rs/crate/sha2/0.11.0), checked 2026-10-07, identifies 0.11.0 released 2026-03-25, with digest 0.11 and cpufeatures 0.3. The chosen 0.10.9 is intentionally the locally cached, independently qualified stable branch; it is not claimed as latest. 0.11.0 remains unqualified here, and its backend/closure/footprint would require a separate comparison. No unsupported claim that older is faster or smaller is made.

## Consumer trace

- `SourceDb::add` hashes exact UTF-8 text bytes; append-only SourceIds keep previous content snapshots. Diagnostic envelopes and generated code/artifacts copy that string.
- `docs::source_revision` builds portable-path sorted `(path, text)` pairs, separated by zero bytes. Its byte construction/order remains unchanged.
- `ide::queries::AnalysisSnapshot::sha256` exposes stored identity; `ide::fixes::apply_fix` hashes current text before range validation and rejects stale content. Existing `compiler/tests/ide.rs::lint_fix_wrap_apply_and_stale`, `compiler/tests/lint.rs::fix_refuses_stale_and_invalid` and `compiler/tests/b3_s4.rs::stale_reapply_reports_both_hashes_as_json` cover real consumers.
- `lsp::server` gates rename against snapshot identity and drops fix edits on content hash mismatch. Code action and rename identity behavior is unchanged.
- `codegen::ir` computes migration `body_digest` over canonical directives joined by LF. Existing `compiler/tests/b3_migrate.rs::body_digest_is_deterministic` covers deterministic and changed directives; artifact serialization carries the result.

## Integrated acceptance and release footprint

The root-integrated [manifest](integrated-Cargo.toml), [lock](integrated-Cargo.lock), [feature tree](features.txt) and [profile](integrated-profile.json) establish the isolated hash-only closure: 47 locked registry packages versus the prior 37. Existing tempfile work shares libc/cfg-if, so adding hash to the accepted file packet adds eight further locked packages, not ten new unique packages.

All six source-module tests pass on macOS aarch64 and local Linux x86_64 under emulation with Rust 1.99; three tests contain fixed hash answers and three retain source/coordinate behavior. On macOS, five focused consumer targets pass 102 tests (IDE stale fixes, lint, migration artifacts, docs revisions and B3 stale identities). The combined file/hash snapshot also passes all 967 compiler tests and Clippy. An independent read-only Sol-low review reports no blocking hash issue. See [consumer-tests.log](consumer-tests.log), [source-tests.log](source-tests.log), [independent-review.json](independent-review.json) and `linux/`.

The Linux build uses the same pinned public Rust image as the file packet, offline locked Cargo, networking disabled and isolated source/cache/target. [Source pins](linux-source-manifest.json), [recipe](linux-run.sh), tool/OS/binary identities and raw release/source-test logs are retained. This does not qualify an installed runtime or every hardware dispatch backend.

[Matched representative footprint](release-footprint.json) compares `unknown` Git-identity isolated binaries with the compiler's existing strip/opt-level z/LTO/one-codegen-unit/unwind profile. macOS: 2,100,432→2,100,448 bytes (+16; 0.0008%). Linux: 2,877,648→2,883,024 bytes (+5,376; +0.1868%). These are representative absolute artifacts, not a throughput benchmark or a guaranteed size result on other hosts. The substitution is accepted for maintained primitive ownership and identical outcomes; no previous hash defect or measured speed improvement is claimed.

`qualify.py` reuses the saved scratch lock with `--locked --offline`; it pins old compiler source at `0104b04`, extracts the current production adapter and asserts independently calculated expected answers. The scratch fixture footprint is not the compiler measurement. Qualified version 0.10.9 is an intentional bounded choice; current 0.11.0 remains unqualified.

No package edits, merge or living-plan checkpoint advancement belong to this packet.
