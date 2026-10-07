# C05D: shared typed serializer and diagnostics

Released writer: diagnostic.rs; root integration: json.rs, Cargo manifest/lock. Borrowed ordered DTOs preserve explicit fields, caller order, compact bytes and the established escape spelling. The two-case Formatter adapter preserves backspace/form-feed as lowercase Unicode escapes; the library owns string scanning. No input parser or numeric model change.

Fixed full-byte foundation witnesses cover empty/full envelopes, controls, Unicode, flags, omission counts, related information and tags. typed_json covers ordering, absent/null/empty, exact raw lexemes and propagated errors, including RawValue's lone-surrogate limit. Real check/lint/fmt subprocesses assert schema/source identity/diagnostics and one newline with a hermetic catalog where accepted. contracts/src/diagnostic.ts is a type mirror, not an executable runtime validator.

The initial raw witness assumed RawValue rejected a lone surrogate; qualification disproved that assumption, which is saved in acceptance-initial.log. A CLI witness initially depended on working-directory catalog discovery, then incorrectly gave fmt a catalog flag; the final witness uses explicit catalog inputs for check/lint and fmt's actual flag profile. Neither failure was a serializer defect. Final acceptance.log records the corrected permanent witnesses.

Pins: serde 1.0.229 std/derive; serde_json 1.0.151 std/raw_value; defaults disabled. Four new lock entries (itoa, memchr, serde_json, zmij), with serde/derive already locked but now enabled. dependency-profile.json records published metadata; dependency-features.txt records activated native closure. No closure-wide minimum Rust claim follows from direct crate MSRVs. Native Rust 1.99/aarch64 macOS qualified now; integrated footprint/Linux receipt follows after family integration.

Official references checked Oct 7: https://docs.rs/serde/latest/serde/ and https://docs.rs/serde_json/latest/serde_json/ plus the exact cached published Formatter/RawValue source. Closed String adapters retain invariant failures; generic errors never become empty/null output. See ../consultation/assessment.md.
