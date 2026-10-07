# Pass 10 final compiler qualification

The selected core substitutions are qualified at their declared compiler/consumer boundaries. Required compiler checks pass, current and freshly installed artifact consumers exercise the final release, and the independent caller review finds no obsolete private core engine or unused direct dependency to remove. Conditional locale/mechanism work and original-product gates remain explicit below. This is a compiler qualification receipt, with no merge, publication or living-plan checkpoint advancement.

## Frozen inputs and required checks

Compiler/Cargo/source bytes are frozen by formatting commit `db495c649880f0eae72f6a42ef60fcc9e904796f`. It applies rustfmt to 13 files and clears the 83 inherited formatting hunks without a semantic edit ([raw diff](format/rustfmt.diff), [format receipt](format/README.md)). [Starting pins](starting-inputs.json) and [final pins](final-inputs.json) cover 114 inputs; only the compiler README changes after freeze. All 47 release inputs in the final no-Git snapshot equal the actual production checkout ([parity](profile/source-parity.json)). Final catalog SHA-256 is `cd984f375e0d6cbcc2bc6aca5ad5ea5b1b3d3ba9cd17b15ab94e4b15e74ced62`.

The final production native binary is `/private/tmp/canlang-pass10-profile/release/can`, 2,250,544 bytes, SHA-256 `6405484cb6156faf26f3efc3a32e57cb193b662581c61995842d78f41baa3c4f`. It reports `can 0.1.0 (commit aca27c2d; language 1.0; schema 1)`: the actual Git observation at build time, while other agents made unrelated commits. Later documentation commits do not change those frozen compiler inputs. A byte-unchanged build-script mtime refresh invalidates stale snapshot Git metadata; [record](profile/metadata-invalidation.json). No altered release profile is credited.

| Required command / public recipe | Final result |
| --- | --- |
| `cargo test --locked --manifest-path compiler/Cargo.toml`, inside `bun run test:compiler` | 1,048 passed, 0 failed, 50 harnesses |
| `cargo fmt --manifest-path compiler/Cargo.toml --check`, inside `bun run lint:compiler` | exit 0; whole compiler formatting passes |
| `cargo clippy --locked --manifest-path compiler/Cargo.toml --all-targets -- -D warnings`, inside `bun run lint:compiler` | exit 0 |
| `cargo build --locked --manifest-path compiler/Cargo.toml`, inside `bun run build:compiler` | exit 0 |
| `cargo build --release ... --offline --locked`, native production plus matched native/Linux snapshots | exit 0; exact invocations/status provenance in profile receipts |
| Five selected integration targets with `--nocapture` | six tests pass, no skip markers; actual runtime seams explicitly execute |

[Raw commands, logs and tool hashes](checks/README.md) preserve the evidence. The public runner uses production task commands and the unchanged native build→test graph. A temporary Turbo root-config copy appends only `CARGO_BUILD_JOBS`, `CARGO_INCREMENTAL`, `CARGO_NET_OFFLINE`, `CAN_COMPLETION_REQUIRE_ENGINES` to passthrough. It retains one-job/incremental-off/offline execution and makes the actual Bash/Zsh completion engines mandatory. The exact [config/profile](checks/runner-profile.json) is independently checked; no package producer task or production runner config is changed. Node 24.21.0, Bun 1.4.2, Turbo 2.11.7 and Rust/Cargo 1.99 are pinned. Rust 1.99 is tested; a lower minimum-version claim is not made.

Default test output alone cannot show optional bodies executed. The narrow [runtime replay](checks/selected-runtime-results.json) explicitly executes six production CLI/default/testkit string witnesses, the actual catalog emitter/source-dist equality/fresh CLI loader, 29 public values URL cases/15 emitted defaults, and the current artifact/Cloudflare/testkit map consumer with an independent decoder. Its two BDD checks assert independently authored emitted bytes; those checks do not execute BDD runtime code.

## Accepted core and predecessor retirement

The [Pass 0 compatibility matrix](../pass0/README.md#classified-compatibility-matrix) and each implementing packet remain the owning contracts. Preserve domain scalar decimal strings/authored scale, required field/array order, omissions versus null, fixed layouts/newlines and exact admitted ID lexemes. Typed LSP field ordering follows its explicitly semantic schema-family contract; malformed bytes/envelopes and known source/URL/file defects are corrections, not compatibility obligations.

| Packet | Final implementation / retired predecessor | Actual acceptance and retained boundary |
| --- | --- | --- |
| C01IR/C01A | Lexer-owned decoded token payload; redundant IR/analysis decoders retired | [Pass 1](../pass1/README.md), final six real CLI/testkit string witnesses. Source-aware lexer errors/spans remain. |
| C02 | Strict framed UTF-8 and explicit LSP envelope/ID admission | [Pass 2](../pass2/README.md), final framed process negatives/lifecycle. Absent/null IDs, signed-i32/string IDs and legal integral spelling stay explicit. |
| C03U | Qualified `url` HTTP(S) adapter; handwritten authority parser retired | [Pass 3](../pass3/README.md), final actual-owner vectors/defaults. Authored ordinary values and trusted-origin policy remain distinct. |
| C04H | Stable `sha256_hex` delegates to `sha2`; compression/padding engine retired | [Pass 4](../pass4/README.md), final unchanged known-answer/boundary/stale-fix consumers. No original hash defect claimed. |
| C04F | Destination-local open `tempfile` ownership; predictable path/counter retired | [Pass 4](../pass4/README.md), final source-mode/failure/link-policy tests. Native/Linux prior host witnesses remain scoped; ownership, ACL and crash durability are not promised. |
| C05D/C05Other | Typed Serde output families and shared string emission | [Pass 5](../pass5/README.md), final diagnostics/fix/docs/policy/explain/descriptors/BDD fixtures and complete current/installed artifact consumers. JS expressions/identifiers are compiler concerns. |
| C06 | Serde grammar with bounded parsing-time seeds/reader | [Pass 6](../pass6/README.md), actual fresh catalog and framed LSP. Ordered duplicates, first-match views, raw lexemes, lexical integer accessors and pinned error/span coupling remain. No second fallback parser. |
| C07DTO/C07URI | `lsp-types` output and qualified shared URL file projection | [Pass 7](../pass7/README.md), final real editor/process tests. Versioned edits, source-owned UTF-16 positions, opaque URI identity, input/transport/lifecycle remain. `lsp-server` is not adopted. |
| C08 | `sourcemap` encoding/numeric VLQ primitive; handwritten production codec retired | [Pass 8](../pass8/README.md), final actual current/installed consumers and independent decoders. Original Can byte columns, generated points, source/name snapshots/order and meaningful unmapped rows remain. |

The independent [retirement review](review/retirement.md) records full caller inventories for 25 symbols and production uses for all seven direct dependencies. It recommends no additional deletion. The remaining source decoder, bounded JSON view/reader, raw numeric/ID renderers, policy/layout wrappers, file metadata checks, URI projection and defensive test-facing map view all have accounted-for callers. They do not reproduce retired standard engines. Tests and public compatibility APIs are callers too; lack of a production call site alone does not authorize removing them.

## Final release and dependency cost

Compare original audit `309644a6881909d8dba32560bc6711f67e00a7ab` to final `db495c6` source snapshots, both without Git metadata (`commit unknown`). Each host uses identical Rust 1.99/profile/target inputs: size optimization, strip, LTO, one codegen unit and default unwind. Reuse existing caches/targets, with jobs 1 and incremental off. The actual-Git production binary is separately qualified. [Exact statuses/artifact hashes/features/checksums/licenses](profile/README.md) bind the measurements.

| Host / scope | Original bytes | Final bytes | Change |
| --- | ---: | ---: | ---: |
| Native macOS arm64 | 1,918,224 | 2,250,544 | +332,320 / +17.32% |
| Local offline Linux x86_64 image | 2,685,944 | 3,079,312 | +393,368 / +14.65% |

Linux uses the pinned image digest in [results](profile/results.json), `--pull=never`, `--platform linux/amd64`, `--network none`. Its release/version/help checks are explicit successful process exits, and earlier per-packet host tests remain their own evidence. This does not claim native Linux hardware, Windows, a fresh full Linux runtime suite or Node/package consumers on Linux.

Build elapsed times are warm-cache observations, not clean-build costs. Failed timing-tool attempts initially masked Cargo failure and copied stale target output; they are preserved and uncredited. Successful Python exit-checked native and Linux retries copy artifacts only after Cargo exit 0. The initial incomplete native-final status receipt is likewise uncredited; the exit-checked retry preserves the exact comparison hash. A diagnostic build-profile override is not accepted as production qualification. Offline full native metadata cannot resolve uncached `futures-task 0.3.34`; Linux-filtered metadata and native/Linux activated feature trees qualify the tested closure. The inactive packaged `js-sys` manifest remains uninspected.

The seven direct pins are `url 2.5.8` (`std`), `sha2 0.10.9`, `tempfile 3.27.0` (`getrandom`), `serde 1.0.229` (`std,derive`), `serde_json 1.0.151` (`std,raw_value`), `lsp-types 0.97.0`, `sourcemap 9.3.2`; defaults are disabled in each declaration. Cargo files are byte-identical to Pass 8: 93 registry packages plus the compiler. Active host closures/features and declared licenses/checksums are pinned separately from inactive targets. No dependency is added in Pass 9/10. Upgrading Serde JSON requires requalifying the narrow error/reader coupling as well as ordinary compatibility tests.

A [fixed actual CLI workload](workload/README.md) uses the same ExpenseFlow/catalog, three warmups and 20 alternating measurements per side. Median full compile/process time is 7.953→7.931 ms; full artifact semantic equality and independent map equality pass for three modules/55 points. This bounded result does not establish a general speed improvement. Accept the measured footprint cost for the selected correctness, ownership and maintenance improvements.

## Actual consumers and original-product limits

[Final consumer qualification](consumers/README.md) pins 18 inputs before/after with no drift and verifies the production binary hash unchanged:

- Three independently asserted CLI probes and thirteen framed LSP probes cover schema/spans/newlines, strict bytes/JSON/envelopes, duplicate/illegal IDs, exact legal numeric spelling, recovery and termination.
- A freshly compiled complete frontend artifact passes unchanged through actual current Cloudflare parse/load/identity/assembler and emitted module import. Unicode/control defaults, BigInt, booleans/nullability and descriptors evaluate as expected. An actual generated create handler refuses an unadmitted caller; the independent map and real testkit report its authored `5:5` location. Twenty-four map rows are independently decoded.
- The same artifact/emitted handler/map/testkit seam passes through a fresh offline scratch install of 13 exact manifest tarballs/131 packages, scripts disabled. All 2,268 installed package file bytes match tarballs; links/realpaths stay in scratch. Node permission mode proves checkout reads fail. Read-only existing Bun cache was cloned into task-local storage after recorded setup failures; no global install/cache mutation/network or package source edits occurred. This is warm offline selected-seam evidence, not cold/full CLI/Worker/browser/persistence/native host release acceptance.
- Unchanged original `draft/CanDo.can` with its owning shared Employees/Locations compiles to complete rejection, exit 10, omitted 0: E3001 at `6159..6164`, E3010 at Employees `1336..1362` and `1477..1503`. Existing T02 B2/B3 adjudication and draft/T36 prerequisites explain those blockers; no patched app or projection substitutes for the original. T37, FP.QUALIFY and FP.INSTALLED-RELEASE remain open at their original acceptance.

## Conditional results and finite next work

| Mechanism | Reviewed result / remaining prerequisite |
| --- | --- |
| Locale C03L | Full `icu_locale_core::Locale` candidate failed owner admission/canonical identity/alias qualification; retained heuristic remains known incomplete. [Failed gate](../pass3/README.md), not completed replacement. |
| CLI/completions | Retain current grammar/metadata. Executed clap/clap_complete prototype needs substantial exact-tail/help preservation glue. Reviewed Bash/Zsh fixes execute; Fish engine remains unqualified. |
| ICU | Retain bounded scanner. Numeric types repaired; ten additional syntax rows form six bounded correction proposals. Full FormatJS/parser adoption not qualified. Outside-plural pound policy is unresolved. |
| Temporal | Retain current owner-derived checks; executed library prototype needs spelling/range/leap/fraction guards. Private core linkage still needs L-F03. |
| Graphs | Defer shared/petgraph migration until preserved diagnostic/witness closure and actual workload benefit. Nondeterministic cycle origin ordering has a separate promoted policy packet. |
| Positions/paths | Retain shared ownership; reviewed bare-CR/inverse-position and retained-parent repairs are qualified. Broader root/external/symlink policy and library adoption are separate. |
| Rowan/Salsa/JS AST | Separate architectural projects; no adoption selected by this utility programme. |

[Pass 9 comparisons and queue](../pass9/README.md) preserve exact mechanisms/writers/outcomes. Stable graph origins and outside-plural ICU pound each await the specific saved verified-context JEV payload approval; automatic approval review rejected sending those repository-derived requests to the external service despite general consultation authorization. No requests were sent or policies selected. Unresolved boundaries block only their dependent packets.

[Economical dispatch](delegation.md) records Luna low/medium and Sol medium task choices, including concrete escalation for an incorrect initial consumer inventory. [Independent final review](review/final-review.md) checks raw evidence and the declared scope; implementing workers do not own their acceptance. README/pass references and decisions are updated, while concurrent package/shared-plan work is preserved. The living file-tree checkpoint must be reconciled after an actual merge by its handler; this qualification performs no merge or checkpoint advancement.

Commits: `db495c6` formatting/freeze; `ea7d0df` final checks/consumers/caller review/workload. Final profile, scope documentation and independent verdict are committed as the closure packet. [Storage/process checks](storage.json) find 24.70 GiB free, no compiler build process and no open native-target PID; the shared Linux target remains held by the host virtualization process. Unique artifacts and shared caches are retained, with no cleanup or new target tree. The task-local install/cache proof occupies about 1.87 GiB and profile snapshots/artifacts about 339 MiB.
