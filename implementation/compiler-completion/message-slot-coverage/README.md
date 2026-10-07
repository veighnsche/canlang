# Named message slot coverage

`check_message_value` now distinguishes structural descriptor checking (`None`) from checking an explicit named-message signature (`Some(&names)`). An empty named signature therefore rejects each undeclared placeholder in the source and translations with E3016 at its authored literal. All four other private callers remain structural-only; their existing checks retain diagnostic ownership. The five-call inventory is recorded in `caller-inventory.json`.

The source snapshots and SHA-256 pins cover the exact implementation, new tests, affected fixture, matching existing tests, DESIGN, Cargo lock and real producer catalog. The narrowly reconstructed implementation diff is `types-coverage.patch`. `analysis-fixture.patch` records the separately authorized correction of the old null-locale fixture's invalid unbound named message to static `"Hi"`. Its original failure is retained in `analysis-message.stdout`; the corrected assertion passes without changing the call or other assertions.

## Verification

All commands ran from the repository root with `cargo test --manifest-path compiler/Cargo.toml` and the listed arguments:

| Receipt | Arguments | Result |
| --- | --- | --- |
| focused | `--test message_slot_coverage` | 6 passed |
| t35r25 | `--test b4_check t35r25` | 9 passed |
| temporal | `--test temporal_message_types` | 3 passed |
| check-icu | `--test check icu` | 4 passed |
| check-message | `--test check message_signatures` | 1 passed |
| b4-message | `--test b4_check message` | 5 passed |
| analysis-message-corrected | `--test analysis message_calls_against_real_catalog` | 1 passed |

`rustfmt --edition 2024 --check compiler/tests/message_slot_coverage.rs` passed. No full suite, package build, all-target Clippy, JEV, Git operation or decision-record edit was performed for this correction.

The new tests use public `check_program`. They check plain, typed and nested undeclared slots in both source and translated literals with exact code, wording and literal spans; zero-parameter static/ICU-quoted text; null and quoted-tag translations; parameterized coverage and translation subsets; structurally valid raw caption/description descriptors; named and inline static `format` with null locale; and explicit parameterized named-message binding with null locale. The latter cases use the pinned real catalog rather than a permissive stand-in.

## Existing anonymous binding gap

The DESIGN's anonymous descriptor postfix call, `"Hi {name}"@{nl="Hoi {name}"}(name="Bo")`, currently fails E3005 (`this value is not callable`) at bytes 123–152 of `anonymous-binding-probe.can`. The failed probe, stdout/stderr and exact finding are saved separately. It is not represented as a successful binding control. This change preserves the structural-only raw descriptor paths; it does not implement anonymous callable typing. The patch affects neither expression MessageValue typing nor call admission, which own that existing limitation.
