# C09I-1 bounded numeric type repair

Implemented the released QUEUE.md contract in `IcuParser::parse_argument` only: parse and validate number style before selecting admissible types; ordinary number accepts Int or Decimal, integer style accepts Int, cardinal plural accepts Int or Decimal, and selectordinal accepts Int. Existing option parsing, depth, selectors, duplicate handling, error code, and literal-span reporting remain on their existing paths.

The independently fixed eight-case matrix runs each combination through both named-message source literals and live translated variants. Negative cases assert E5007 at the offending literal. Additional controls assert unsupported number style for both Int and Decimal translated variants, and verify the original source span when a decoded Unicode escape names the incompatible decimal integer argument. Existing ICU grammar and selector controls were rerun.

Validation: `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --manifest-path compiler/Cargo.toml --test check icu_ -- --nocapture` passed all four selected tests (33 filtered out), using the existing compiler target. `rustfmt --edition 2024 --check compiler/src/analysis/examples.rs compiler/tests/check.rs` and scoped `git diff --check` passed.

Evidence consulted: frozen `pass9/icu/type-parity.json`, `/private/tmp/canlang-pass9-icu/parity.mjs`, and the decimal ordinary-number source fixture. No parser candidate, dependency, runtime value implementation, decimal literal lowering, or other type owner changed. This verifies compiler type admission; it makes no claim about emitted decimal default execution. Root owns independent CLI/public-owner replay, review, shared decisions, and commit.
