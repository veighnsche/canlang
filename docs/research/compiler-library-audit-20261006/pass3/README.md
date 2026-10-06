# Pass 3 — URL implementation and locale qualification

2026-10-07. **C03U is implemented and qualified on the required macOS aarch64 and Linux x86_64 targets. C03L's full Locale candidate failed; its replacement remains gated.** This receipt does not mark locale replacement or installed release artifacts complete.

URL parsing was committed early as `f3612ea` (`fix(compiler): use URL parser for HTTP value admission`). The remaining commit transfers the production runtime regression, qualification witnesses, independent review and accepted decision. No package files are changed by this work; the concurrent package agent's Rust ports are outside this receipt. No merge occurred and no living-plan checkpoint is advanced.

## Implementation and compatibility matrix

`compiler/src/analysis/types.rs::valid_url` calls `url::Url::parse` without a base and accepts parsed `http`/`https` schemes. It discards the parsed object and keeps the authored decoded string. The handwritten authority validation and unused unsafe `strip_scheme` helper are removed. The caller closure remains `validated_shape` → contextual `type_literal` and overload `inhabit_validated`; rejected literals use E3001 at the existing tight byte span.

| Contract | Classification and implementation | Witness |
|---|---|---|
| Absolute ordinary HTTP(S) values | Existing owner compatibility; parser admission only | 29 independent outcomes, actual decode/direct encode/roundtrip and compiler routes |
| Three-emoji input | Demonstrated tool failure repaired to source diagnostic | Old release exits 2 without a check envelope; new release E3001 with exact literal span |
| Malformed brackets, high ports, Unicode/percent host failures | Demonstrated false admission repaired | Explicit negative vectors; owner error categories; release CLI |
| Credentials, parser-accepted whitespace/path spaces, empty ports and `http:example.com` | Earlier checker was stricter than the owner; correct admission | Positive vectors and actual package exports |
| Authored URL value | Byte-equivalent decoded string retained, including case/spacing/backslashes | Artifact default, executed emitted JS default and public value roundtrip |
| Trusted `app_url` origin | Separate owner contract, unchanged | Actual constructor rejects credentials/query; canonical mount construction succeeds |
| Compiler rejection | E3001 and source byte anchors preserved; human parser detail may differ | Both scalar routes and release check envelope |
| JSON output layout / number spelling / LSP admission | Outside this packet | Existing full suite retained; no JSON/LSP adapter change |
| Locale parser/identity | Failed candidate, no product replacement | 53 full Locale cases, four admission/seven identity mismatches and six canonical collisions |
| Hosts | macOS aarch64 and Linux x86_64 release/CLI executed; actual Node/package seam on macOS | Linux runs locally under emulation; installed artifacts and native performance unqualified |

The original owners and acceptance are frozen in [Pass 0 value contracts](../pass0/value-contracts.md). Relevant prior fixtures include `fixture_mime_and_quoted_locale_keys`, descriptor negatives in `b4_check`, source/default metadata in codegen and existing values wire/locale contracts. The full compiler suite reruns the compiler acceptance; package test suites were not rebuilt or run. Existing built package exports and the actual catalog are pinned comparison inputs.

## Permanent regressions and actual owner evidence

[url/vectors.json](url/vectors.json) contains independently specified expected admission outcomes, rather than deriving expected values from either parser. Its 29 cases cover emoji, bracketed hosts, boundary/excessive/nonnumeric ports, credentials, Unicode/IDNA hosts, backslashes, ASCII tabs/whitespace, relative inputs, scheme case, legacy IPv4 and invalid host versus path percent sequences. There are 15 accepted and 14 rejected values.

`compiler/tests/analysis.rs::c03_url_owner_admission_and_source_anchors` applies all 29 cases to contextual URL field defaults and overload literal admission. Its test-only catalog declaration supplies a URL argument route because the actual catalog currently has no suitable builtin URL parameter; it is not a runtime API proposal. Rejections must produce exactly E3001 over the authored token's byte span. These 58 cases pass without panic.

`compiler/tests/value_admission.rs::url_values_retain_authored_text_through_production_metadata` imports the actual bare `@canlang/values` export and runs [public-probe.mjs](url/public-probe.mjs). It asserts retained decode/direct encode/roundtrip values and the owning error families: invalid decode is `SchemaError` / `schema` / `format`; invalid encode is `ValueError` / `invalid-construction`.

For all 15 accepted values, the test invokes the production compiler CLI against `packages/values/dist/catalog.json`, passes its completeness gate, checks the artifact default, writes all emitted modules unchanged and imports the entry with the real UI package. The executed model default and actual values API results equal the authored decoded string. There is no synthetic complete emission, runtime substitute, or application-operation execution claim. The 90-second outer Node deadline and 10-second compiler deadlines bound the seam. Missing prerequisites/non-Unix skip with an explicit message; **Cargo success alone is not execution evidence**. [runtime.log](url/runtime.log) confirms this seam actually ran on Node v24.21.0 / ICU 78.3.

The independently reviewed test had no actionable false positive. Review verified the actual imports, completeness gate, emitted bytes, artifact/metadata checks, timeout and cleanup, while retaining the skip/application limits above.

## Dependency and host profile

Direct dependency: `url = { version = "=2.5.8", default-features = false, features = ["std"] }`. The compiler lock and scratch candidate have identical 37 registry name/version/checksum tuples. [compiler-features.txt](url/compiler-features.txt) records enabled features; optional Serde lock entries do not enable Serde integration. Unicode host validation intentionally uses IDNA's compiled ICU4X data. No native system library is introduced by this selected graph.

The published URL manifest declares MSRV 1.63 and MIT OR Apache-2.0; the maximum declared transitive MSRV is 1.88, with some transitive manifests lacking a declaration. The compiler baseline Rust 1.99 was executed; Rust 1.88 was not. Locked manifests include Unicode-3.0 and the combined unicode-ident license. See [published dependency metadata](url/dependency-profile.json), the exact lock and [final profile](dependency-profile.json).

Both original `74f7271` and current compiler snapshots build with the existing stripped `opt-level=z`, LTO, single-codegen-unit macOS release profile. Executable size changes from 1,918,256 to 2,100,432 bytes: +182,176 bytes (+9.5%). This is a binary-size comparison with different source/build metadata, not a startup, latency or memory measurement. The new release qualifies 29/29 CLI outcomes versus 16/29 for the old checker. [release-probe.py](url/release-probe.py) preserves those independent expected results and diagnostic anchors; its old-build record tolerates missing JSON to retain the panic witness.

Automatic approval review rejected private source/catalog upload to the configured Linux `infra` host without explicit destination authorization. The upload did not occur. A safer local Docker route then qualified `x86_64-unknown-linux-gnu` with Rust 1.99 in a pinned public image, under emulation on the ARM64 engine. Private sources remain in an isolated local read-only copy; container networking is disabled and the 37 public crate archives match lock checksums. Linux release build, 97 library tests, 58 analysis-route cases and all 29 release CLI outcomes pass. On Debian 13.7 the same-image baseline/current release size changes from 2,689,400 to 2,877,648 bytes: +188,248 bytes (+7.0%). No remote approval is now needed. The first lib run lacked its unchanged ExpenseFlow golden fixture; that failure is retained, the exact fixture was copied and 97/97 then passed without product changes. [Linux evidence](linux/results.json) and [replay script](linux-local-run.sh) record the profile. These checks do not qualify native hardware performance, installed artifacts, every WHATWG string or future Unicode data; actual Node/package runtime execution remains macOS evidence.

## Locale gate and next packet

Sol medium evaluated full `icu_locale_core::Locale = 2.3.0`, `alloc`, defaults disabled against `canonicalLocale`, decode, encode and `makeMessageDescriptor` from the actual built package. The final bare-export replay records Node v24.21.0 / ICU 78.3 / CLDR 48.0. Core accepts required Unicode/private extensions and rejects duplicate region/variant cases, but fails four admitted long-language inputs and seven canonical identities. A transform duplicate-field case loses data, so adding alias data after this parser is insufficient.

[The independent Sol high review](locale/independent-review.md) reproduces all failures, investigates bounded library alternatives and defines a finite follow-up across admission, source/variant canonical identity and generated locale keys. `valid_locale` remains unchanged and known incomplete. No hand-curated alias table, unqualified syntax-only release or native ICU policy was selected. ICU core appearing transitively in URL's IDNA graph is not locale replacement acceptance.

Retain the existing pass sequence. Expand only C03L's candidate/identity packet to cover the demonstrated representation failures and quoted generated keys. URL work and later unrelated packets need not wait. Consequential selection of an alternate locale profile/API still requires verified-context triple JEV consultation; preserving the user-defined failed-candidate gate selects no new policy and required no consultation here.

## Verification and delegation

- Full compiler suite: **948 tests passed**, [full-suite.log](full-suite.log).
- Clippy all targets with `-D warnings`: passed, [clippy.log](clippy.log).
- Focused URL analysis: 29 vectors × two routes passed, [analysis.log](url/analysis.log).
- Actual public owner + production emitted defaults: 29 owner vectors + 15 defaults passed, [runtime.log](url/runtime.log).
- macOS baseline/current release builds and current release 29-case CLI qualification passed; old outcomes retained for classification. Linux x86_64 release, 97 lib tests, 58 route cases and 29 release CLI cases passed under local emulation.
- Formatting: the same **88 pre-existing hunks**, after removing only checkout prefixes and diagnostic line numbers. The new test is formatted; existing files were not broadly reformatted. [fmt-comparison.json](fmt-comparison.json).
- Input pins: baseline and final SHA-256 manifests distinguish the four implementation files plus the new test; owning package/catalog/runtime comparison inputs did not drift during checks. Concurrent package Rust changes are not included in this claim.

Delegation followed the [researched Pass 3 allocation](../model-allocation-20261007.md#pass-3): Sol medium for URL and locale qualification, exclusive URL writer, production test and independent URL/test review. Sol high was confined to the demonstrated locale owner-profile conflict and alternate-candidate review. The coordinator integrated the sole manifest/lock and Git changes. No comparative model benchmark or token saving is claimed.

Saved candidate reports describe their original read-only scratch stage; this coordinator receipt describes the subsequent implementation and replay. Logs trim trailing whitespace and final blank lines for repository hygiene; assertions compare the actual values before that log normalization.
