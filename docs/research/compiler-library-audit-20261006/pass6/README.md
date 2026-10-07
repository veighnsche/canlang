# Pass 6 JSON input-engine receipt

**Complete:** pinned Serde now owns catalog/LSP JSON grammar and Unicode decoding. The handwritten parser is retired. A small ordered/raw compatibility view remains for actual caller requirements; existing structural rendering and typed output policy remain unchanged.

Commits: `c7d240b` freezes independent contracts/baseline witnesses; `1f936f8` releases the reviewed engine and actual caller regressions. This receipt closes host/cost acceptance. No packages files changed or rebuilt; the package agent's work and Git staging remain independent. No merge or living-plan checkpoint advancement.

## Contract and implementation

The [finite contract/matrix](CONTRACT.md) and [caller closure](caller-contract-review.md) establish ordered decoded duplicate pairs, first lookup, exact legal numeric lexemes of arbitrary magnitude, lexical i64 access separately from exact signed-i32 LSP IDs, strict keys/strings/UTF-8, complete documents, unknown-field admission, original depth 0..64/empty-terminal behavior, and inclusive 64 MiB pre-allocation LSP body bound.

Existing serde 1.0.229 (std/derive) and serde_json 1.0.151 (std/raw_value), default features disabled, suffice. Cargo manifest/lock and activated features are unchanged. The library’s [DeserializeSeed](https://docs.rs/serde/1.0.229/serde/de/trait.DeserializeSeed.html) and [reader deserializer](https://docs.rs/serde_json/1.0.151/serde_json/struct.Deserializer.html) provide the input seam. Library primitive IgnoredAny is used only for actual numbers; it validates grammar without float/range conversion or synthetic marker objects. Strings/keys and all containers use strict bounded visitors; no whole-subtree RawValue/ignored scan bypasses protection. Pinned single-byte reader lookahead and root/map/array seed origins preserve exact source slices. Production adapter is186 lines including native error setup, guards, visitors and documentation versus292 old grammar/UTF-8 lines; the earlier90-line scratch estimate excluded production error/setup/docs. Full-file growth comes from permanent tests, not a new grammar.

ParseError.message intentionally changes from &'static str to String. Native reasons retain the `invalid JSON at byte N: reason` envelope; exact old diagnostic text/locations are not promised. No current production field readers/constructors exist, and no production Rust package depends on this compiler crate; outside Rust source users remain unqualified. The [40-case classified matrix](error-compatibility.json) records intentional details while actual catalog E6003/E6004/origin/primary and fixed LSP -32700/null response remain required.

[Clean-room Sol-high review](review.md) found a P2 nested error-offset defect and verified the correction: first-failure snapshots survive Serde cleanup, including EOF reached only while unwinding. Current source SHA256:6f6b067e3a57c4cb50596712cab981eea199c1774150b1b946042492685f4244. No blocking findings remain. Sol high owns compatibility/writer/review; Sol low owns routine catalog/producer/cost tasks; Sol medium owns real LSP witnesses. No model escalation beyond researched allocation.

## Actual outcomes

- Baseline/new independent JSON expectations cover numeric grammar/raw contexts, decoded duplicates/private-marker objects, strict Unicode, malformed trailing/delimiters and exact depth edges. The 10k-bracket fixture stops after66 read bytes before excess child/tree construction.
- Actual catalog loader and fresh CLI pass both valid owning catalog and malformed ignored fields/Unicode/bytes, duplicate entries, signature failures and depth edges, preserving codes and source anchors. New six-case catalog and26-case LSP targets also pass against the baseline.
- Actual Node 24.21.0 imports authored CATALOG via type stripping and agrees with built CATALOG. Unchanged owning emit-catalog.mjs runs isolated, validates implemented runtime exports and emits59 entries/15 features. Fresh22,290-byte output equals existing bytes/SHA256 cd984f375e0d6cbcc2bc6aca5ad5ea5b1b3d3ba9cd17b15ab94e4b15e74ced62. Actual runtime Unicode trim, Rust loader and fresh CLI check pass without skip. No package build or alternate emitter is used.
- Real LSP tests assert fixed malformed-byte/grammar/envelope responses, decoded reserved duplicates, raw numeric/string ID replies, unknown-field strictness, depth64/65, marker objects, legal initialization/shutdown/exit, recovery and disconnect behavior. Framing quirks/body policy remain unchanged.

## Integrated checks and profiles

Native Rust 1.99.0(b940084d7)/LLVM 23.1.1, aarch64-apple-darwin on Darwin 27.0.0: complete suite: 1,026 passes after the functional correction. Equivalent map_err→inspect_err polish then passes5 private tests and39 real caller tests with all-target Clippy -Dwarnings. Actual native package consumers execute; no package-profile skip. The existing macOS mode 4750 subcase remains unqualified from Pass 4. Scoped formatting passes; full-tree formatting retains 83 pre-existing hunks, zero added.

Pinned local Linux x86_64 emulation, Debian 13.7/Rust 1.99.0, image rust@sha256:24e632c09342c20abf8312cf4f61430a911c01ed3a5e4c02b87292b1c39c5273 (amd64 child sha256:458b145eb2406e832adc9c9536d487c5d264401a4ce63adbeced3fe91292616c): final: 114 library + 39 integration harness passes. Two catalog package-profile tests explicitly skip absent packages in this compiler-only Linux snapshot, so 151 executed tests are claimed; their full runtime/producer seams are native-qualified. Docker uses the already-local image/cached checksummed crates, --network none and isolated temp mounts, with no source uploads/service changes. No Windows execution is claimed.

All 101 final compiler input files match the live tree. Compiler/catalog/runtime inputs and source/current artifacts are SHA-pinned in [profile/results.json](profile/results.json) and the input manifests; no catalog/runtime/tool drift beyond intended json.rs change occurred. Linux baseline binary is reused only after 41 core-source/Cargo inputs match the already-qualified Pass 5 profile. Both before/after releases use isolated unknown-Git snapshots and identical build profile/tool/features.

| Release footprint | Before | After | Delta |
| --- | ---: | ---: | ---: |
| macOS aarch64 | 2,150,544B | 2,167,152B | +16,608B /0.77% |
| Linux x86_64 | 2,947,352B | 2,960,352B | +13,000B /0.44% |

## Cost and accepted trade-off

Final unchanged actual parser modules, offline release, parse+drop/black_box, two warmups and seven alternating rounds after own builds finish. Other system activity is not guaranteed isolated; raw rounds and earlier noisy estimates remain saved. [Reproduction/evidence](benchmark/README.md):

| Input | Old median | New median | Ratio |
| --- | ---: | ---: | ---: |
| Actual 22,290 B catalog |60.722µs |81.480µs |1.342× |
| Actual 107 B initialize |.356µs |.575µs |1.614× |
| Fixed 367,501 B mixed |1.276ms |1.866ms |1.462× |
| Fixed 2,205,001 B mixed |7.749ms |11.262ms |1.453× |

Fresh actual CLI check, independent complete=true/diagnostics=[] outcomes, three warmups and 40 alternating rounds: old 3.030 ms/new 3.045 ms median (1.005×). This one fixture is not a general latency/no-regression claim. Actual catalog parsing adds about 21 µs while retiring bespoke grammar/Unicode processing; extra code and measured throughput/footprint are proportionate for the exercised profile.

[Three preauthorized JEV consultations](consultation/assessment.md) split 2–1 with material uncertainty on engine and error choices. Investigated options fairly: keep proven bounded grammar (faster/no coupling, retirement incomplete; no new defect claim), qualify pinned small cursor adapter (selected after actual witnesses/cost/review), or two-pass bounded validation/raw rebuilding (unqualified, more reparsing/features/adapter work). Choose the tested small adapter, retain explicit upgrade witnesses and measured costs. Advice never selects acceptance on its own.

Remaining limits: private reader/seed behavior needs upgrade requalification; errors have deliberately different native details/public Rust field type; depth protection prevents excess descent/tree construction but library cleanup may scan whitespace/lookahead, so 66 bytes is only the bracket witness; package-runtime Linux and external Rust source consumers are unqualified. No new catalog byte cap, framing repair, typed LSP output/framework transport, JS AST, coordinate or ordinary serializer redesign belongs to this packet.
