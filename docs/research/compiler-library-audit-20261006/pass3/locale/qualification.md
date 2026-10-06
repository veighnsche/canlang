# C03L locale candidate qualification — 2026-10-07

Status: **failed direct candidate; gated full replacement**. C03U URL qualification is independent.

## Executed evidence

Scratch `Cargo.toml`, `Cargo.lock`, `src/main.rs`, `probe.mjs`, `results.json`; `cargo run --offline` succeeded with `icu_locale_core = "=2.3.0"`, `default-features = false`, `features = ["alloc"]`. Cached manifest: edition 2024, rust-version 1.88 (compiler requires 1.99), Unicode-3.0 license, Unicode ICU4X upstream https://github.com/unicode-org/icu4x. No crate download or repository/package edits/builds performed.

Public package root exports canonicalLocale, decodeValue, encodeValue and makeMessageDescriptor were invoked on existing built exports, Node v24.21.0 / ICU 78.3 / CLDR 48.0. 53 locale inputs and 6 descriptor canonical-duplicate pairs. This is pinned existing-output qualification, not clean package rebuild or installed-tarball proof.

Full Locale accepts en-u-ca-gregory, en-x-private, und, numeric region en-123 and en-000; rejects en-US-US, sl-rozaj-rozaj, en_US, x-private, i-klingon, en-GB-oed, zh-min-nan, en-12 and en-1A2. All four owning APIs agree on those outcomes. Duplicate Unicode attributes/keys are admitted and normalized by both (en-u-abc-abc, en-u-ca-gregory-ca-buddhist). Duplicate extension singleton en-a-foo-a-bar is rejected by both. en-u-kn-true normalizes to en-u-kn without CLDR alias data in core.

Four admission mismatches: owner accepts abcde, abcdefgh, abcde-US-u-ca-gregory and en-t-abcde; core rejects them. Do not label 5–8-letter primary languages invalid just because registry membership is uncommon: owner grammar permits them. Four-letter abcd and nine-letter abcdefghi are rejected by both.

Seven canonical identity mismatches: iw→he, sh→sr-Latn, mo→ro, en-SU→en-RU, en-u-ca-islamicc→en-u-ca-islamic-civil, en-t-iw→en-t-he, and en-t-m0-foo-m0-bar→en-t-m0-bar-m0-foo. Core leaves legacy aliases intact; for the last transform-key case it keeps first value only (en-t-m0-foo), losing information owner preserves. The six duplicate-pair constructors reject canonical identity collisions with ValueError invalid-construction; lowercase-only compiler comparison misses all except nl/NL. Decode rejects malformed input with SchemaError containing path [] / code format violations; canonicalLocale, descriptor construction and encode use ValueError invalid-construction. Diagnostics must preserve boundary distinctions.

## Official source evidence

https://docs.rs/icu_locale_core/2.3.0/icu_locale_core/struct.Locale.html — full Locale::try_from_str requires alloc; parser does syntax normalization but no legacy replacements; maximum language length three; underscores dropped since 2.0.0. Unicode extensions/private use require full Locale, not LanguageIdentifier.

https://docs.rs/icu/latest/icu/locale/struct.LocaleCanonicalizer.html — current umbrella documentation 2.3.1 exposes new_common/new_extended with compiled_data and canonicalize. It explicitly records missing Unicode calendar-type canonicalization data (islamicc) in CLDR JSON. Treat as a stronger language/region alias candidate only, not qualified owner equivalence. The exact icu_locale version, features, dependencies/data version, MSRV/license and executed behavior remain unqualified because it was not fetched. Bigger alias data cannot recover parser-discarded duplicate transform fields or represent 5–8-letter primaries.

https://tc39.es/ecma402/#sec-isstructurallyvalidlanguagetag — owner is ECMA-402 Unicode locale grammar and canonicalization rather than all grandfathered/private-only RFC BCP47 strings. Host profile is pinned observation, not universal future Intl proof.

## Complete caller closure required

compiler/src/analysis/types.rs current lines: validated_shape15322 → valid_locale15449; type_literal9948 and inhabit_validated14322 reach validated scalars (E3001); message variant check4412 reaches direct admission (E3016); context default5678 and owner source attribute5726 reach direct admission (E3001). Message identity4420–4421 currently lowercase only. collect_module_sources4903 records raw source tag at4917; module_source_tag4565 reads it (default en). Canonical source identity must use the same qualified function as variant identity; preserve authored source/tag text for spans and diagnostics and avoid synthetic duplicate diagnostics on invalid owner source.

No runtime canonicalization or compiler-generated alias table is currently qualified. A replacement interface should be canonical_locale(&str)->Result<String, LocaleProblem>, reused by admission and identity consumers, with wrappers retaining existing E3001/E3016 and tight_span placement. Admission alone is separable only with explicit unresolved identity status, but direct core admission itself fails ECMA grammar on long primaries.

Full message workflow has a separate existing codegen issue: compiler/src/codegen/js.rs::lower_message2415 uses sanitize_ident(locale)2430; sanitizer972 turns '-' into '_', producing invalid descriptor keys for admitted extension/region/private tags. Targeted quoted-string key emission is required for complete generated workflow; this is outside the worker's allocated write scope. No edit made.

## Implementable choices and gates

1. Defer C03L replacement, record failed candidate + owner witnesses, preserve C03U progress. No data/API invention and no false parity claim.
2. Explicitly scope a core-backed admission adapter with bounded ECMA grammar bridging for 5–8 primary and transform-language slots; no hand-curated locale alias list. This is additional adapter implementation/qualification, not already proved. Source/variant aliases remain open unless separate data identity closes them.
3. Qualify data-backed ICU canonicalizer plus explicit ECMA compatibility adapter and bounded pinned Node/ICU/CLDR profile. Must address long primary representation, transform duplicate-field semantics, Unicode calendar alias data, source/variant canonical identity, generated locale keys, Linux/macOS release checks, and exact data/license/version provenance. Avoid giant handwritten alias table.

Targeted consequential JEV choices for root: whether syntax-only scope is acceptable while data identity remains open; whether exact pinned owner canonical identity should be required before locale checker release or explicitly deferred; whether retaining all owner grammar including 5–8-letter primary/duplicate transform fields warrants compatibility adapter complexity versus deferral. Consult with balanced equivalent triples only if selecting a new policy; this worker did not choose or consult a policy. Actual owner conflict reported to root for high reasoning escalation.
