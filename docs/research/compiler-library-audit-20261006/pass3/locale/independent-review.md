# C03L independent review and finite next packet

2026-10-07. Sol high was used only after Sol medium qualification demonstrated an owner-profile conflict. The reviewer independently reran all 53 inputs against the pinned full `icu_locale_core::Locale` binary and all four owning APIs, and all six duplicate-pair descriptors. Admission, canonical identities, error families and duplicate outcomes agreed with the initial observations. The coordinator then replayed `probe.mjs` through the bare `@canlang/values` package export; [results.json](results.json) preserves that final replay, including its entry and binary hashes.

## Candidate fails the existing owner contract

| Boundary | Concrete counterexamples | Consequence |
|---|---|---|
| Admission | `abcde`, `abcdefgh`, `abcde-US-u-ca-gregory`, `en-t-abcde` | Owner admits all four; full core rejects them. A three-letter language representation does not cover ECMA-402's five-to-eight-letter primaries. |
| Language/region aliases | `iw → he`, `sh → sr-Latn`, `mo → ro`, `en-SU → en-RU` | Core syntax normalization alone cannot provide owning canonical identity. |
| Extension aliases | `en-u-ca-islamicc → en-u-ca-islamic-civil`, `en-t-iw → en-t-he` | Identity needs extension-aware alias handling, not lowercase comparison. |
| Transform fields | Owner `en-t-m0-foo-m0-bar → en-t-m0-bar-m0-foo`; core `→ en-t-m0-foo` | Parsing loses information. A later canonicalizer cannot reconstruct discarded values. |

Full core does handle `en-u-ca-gregory` and `en-x-private`; the failure is not use of a language-only API. Duplicate regions/variants, malformed input and canonical collision pairs are in the replay. All six owner collision pairs fail descriptor construction with `ValueError` / `invalid-construction`. Lowercase identity catches only the `nl`/`NL` pair.

Invalid wire locale decoding reports `SchemaError` with a `format` violation; direct encoding, canonicalization and descriptor construction use `ValueError` / `invalid-construction`. Compiler diagnostics remain a separate source boundary: E3001 for scalar/context/source admission and E3016 for message variants. No locale product code was changed, so these new vectors are candidate evidence, not passing compiler regressions.

## Bounded alternatives investigated

The reviewer checked primary documentation and implementation sources. `language-tags` canonicalization suppresses `en-Latn` to `en`, whereas the owner preserves `en-Latn`. `langtag` supplies RFC syntax rather than the required data-backed identity. Boa's Intl path uses ICU4X's same Locale representation. None was executed as a qualified replacement.

ICU4X `LocaleCanonicalizer` is a stronger alias candidate, but its documentation identifies missing calendar-type alias data such as `islamicc` in CLDR JSON. Its pinned version/features/data were not fetched or qualified here. Even complete alias data would not repair the demonstrated representation and information-loss failures.

Pinned Node v24.21.0 uses a Unicode base grammar gate followed by ICU language-tag parsing, LocaleBuilder construction, canonicalization and language-tag serialization. An ICU4C adapter matching that pipeline is a credible **future candidate**, not a selected API. ICU4C's language-tag parser alone accepts a broader profile and can truncate invalid input; its native dependency/build/data footprint would need evaluation against Can's standalone binary and supported hosts.

Primary sources checked:

- [Full Locale 2.3.0](https://docs.rs/icu_locale_core/2.3.0/icu_locale_core/struct.Locale.html)
- [ICU4X canonicalizer and missing calendar data](https://docs.rs/icu/latest/icu/locale/struct.LocaleCanonicalizer.html)
- [ECMA-402 structural admission](https://tc39.es/ecma402/#sec-isstructurallyvalidlanguagetag)
- [language-tags](https://docs.rs/language-tags/latest/language_tags/struct.LanguageTag.html) and [langtag](https://docs.rs/langtag/latest/langtag/)
- [Boa Intl locale implementation](https://raw.githubusercontent.com/boa-dev/boa/main/core/engine/src/builtins/intl/locale/utils.rs)
- [Pinned V8 canonicalization](https://raw.githubusercontent.com/nodejs/node/v24.21.0/deps/v8/src/objects/intl-objects.cc) and [Unicode locale grammar gate](https://raw.githubusercontent.com/nodejs/node/v24.21.0/deps/v8/src/objects/js-locale.cc)
- [ICU4C Locale API](https://unicode-org.github.io/icu-docs/apidoc/released/icu4c/classicu_1_1Locale.html)

## Exact retained closure and next work

The current heuristic remains at `analysis/types.rs::valid_locale:15397`. It is known incomplete; retaining it under the user-defined failed-candidate gate is not correctness acceptance. The unchanged caller closure is:

- `validated_shape:15322`, contextual `type_literal:9948`, and overload `inhabit_validated:14322`: E3001 and tight literal anchors.
- `check_message_value:4412`: E3016 admission; nearby lowercase identity must eventually use qualified canonical identity.
- Explicit context locale at 5678 and owner `source=` at 5726: E3001.
- `collect_module_sources:4903` retains raw source tags; `module_source_tag:4565` defaults to `en`. Source/variant identity must share one qualified function while authored spelling remains available for diagnostics.
- `codegen/js.rs::lower_message:2417` uses `sanitize_ident(locale):2430`, changing `en-US` to `en_US`. Quoted locale key emission must be included in the eventual complete workflow packet.

The next C03L packet needs one `types.rs` writer and a coordinated codegen writer. It must:

1. Qualify one parser/canonicalizer profile with pinned grammar, aliases/data, versions/checksums, license, MSRV, build/link requirements and macOS/Linux release footprint.
2. Replay the 53 inputs and six collisions, adding grammar-driven long primaries, transform duplicate fields, calendar aliases, trailing input and long tags. Require zero differences within the declared owner profile, or consult before proposing a changed contract.
3. Use the qualified canonical identity across scalar, context, source and message-variant consumers; preserve E3001/E3016, authored text and anchors, and avoid secondary duplicate errors for an invalid owner source.
4. Emit quoted locale keys and execute production metadata with the actual `makeMessageDescriptor` export. Promote independent expected outcomes into permanent compiler regressions at those boundaries.

No new policy alternative was selected. Keeping the explicit failed-candidate gate requires no new JEV decision. Choosing a native ICU adapter, relaxing owner identity, or introducing a compatibility adapter would require three independently worded, equivalent verified-context JEV consultations under AGENTS.md. Advice would not substitute for executable qualification. C03U proceeds independently; no broader sequence rewrite is needed.
