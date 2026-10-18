# Description and internal reference contract

This file defines the frozen representation named by `compiler/src/analysis/effects.rs`. Current work/status and D08 closure live only in [REMAINING-WORK.md](REMAINING-WORK.md). Description/reference behavior and six concrete repairs are accepted at their recorded scopes; this is not an implementation queue. Choices and rationale remain in [DECISIONS.md](../specification/DECISIONS.md).

## Shared description value

1. Keep `#` as the readable multiline description form. Add `desc=` as the compact field/parameter form. Both populate one logical description slot; `label=` remains a short caption and does not silently become documentation.
2. The initial `desc=` value is a source string with optional keyed variants, or an existing static zero-parameter message reference. Reuse source-owner identity and fallback semantics. No record queries, execution, implicit interpolation, or parameterized descriptions.
3. Reject duplicate descriptions on one declaration, whether written with `#`, `desc=`, or the legacy annotation. No silent precedence or concatenation.
4. Accept existing literal `@{desc="..."}` as a compatibility spelling of that same slot during this change. Locale keys inside that legacy flat annotation remain invalid. Do not bulk-rewrite drafts to establish support.
5. Preserve source text, owning source-language identity, variants, and source location in the checked description value and reference model. The reference consumes the complete value. Existing MCP deliberately renders source-language text in this first delivery; that boundary must be documented, never mistaken for localized output.
6. Optional translations create no global requirement to translate every description. An explicit strict-coverage mode would be separate requested scope. Preserve existing fallback and distinguish absent variants from empty text.
7. Description metadata affects documentation only. Stored values, stable declaration/operation identities, business types, schema constraints and authority stay derived from their existing owners.

Example of proposed syntax, not a passing current program:

```can
P {
 name:text desc="The name shown to customers."@{nl="De naam die klanten zien."},
 amount:int
}
```

## Frozen first-delivery representation and rendering boundary

Use one compiler-owned static description representation: `source:string`, `sourceLang:string`, `variants:ordered (tag,string|null) pairs`, and `location:{sourceId,start,end}`. Absence is an optional description; empty source/variant strings remain distinct from absence. Descriptions carry no runtime parameters. Resolve static message references under their owning source language before building this value. Adapt a legacy literal annotation as source text with no variants and the field/parameter owner language; do not mutate source.

The initial reference model v1 covers owners, models/contracts and fields, user operations with inputs/results, descriptions, source links and authored examples. It reads checked descriptions directly, independently of artifact transport or MCP locale support. Resolved constraints and creation metadata belong with field/input facts. Policies/guards/effects/routes are not a mandatory first-delivery inventory; include only located facts already available without creating a new semantic inference pass.

Choose a concrete reuse boundary: Rust analyzes source and produces the internal reference model; a TypeScript reference renderer selects static descriptions using `@canlang/values` `resolveVariant`, then writes Markdown. `can docs` uses the existing `can-platform` runtime locator/child-process boundary for this renderer after successful analysis; pass structured reference data through stdin, with fixed arguments and no shell evaluation. The standard platform runtime is required for this output, just as existing run/build commands use it; missing runtime/renderer produces a truthful tool error.

The renderer uses existing runtime canonical locale handling, explicit requested locale or app default, owning source language, null-variant omission and existing whole-message fallback. It does not implement a second Rust locale engine or parse raw description prose as parameterized ICU. Reuse static selection, not formatting that could reinterpret literal braces. Keep shared fixtures covering canonical aliases/case, regional fallback, absent/null/empty variants, app-default fallback and source-owner fallback. Add an explicit package dependency on the existing values producer where needed; no new external localization library is required.

## Reference output contract

The first output is Markdown for internal developers/integrators, with stable owner/declaration anchors. Invocation:

```sh
can docs app.can --locale=nl --out generated/reference.nl.md
```

Without `--out`, render Markdown to stdout. Without `--locale`, use the app default and existing source fallback. Keep global diagnostic `--format=json|text` separate from documentation format.

Use the compiler's existing analyzed sources, selected app and canonical ownership graph. Do not build a second language parser or scrape generated MCP JSON as the complete reference. Generate only after required source analysis succeeds; report diagnostics and produce no misleading successful reference on failure. The generator does not require running business handlers or qualifying the original draft apps.

For the first-delivery declaration set, output:

- Canonical owner/declaration identity and kind, authored description, and source location.
- Model/contract fields and operation inputs/results, their declared/resolved types, nullability, creation requiredness, defaults and value constraints. Preserve the distinction between creation metadata and value type.
- Source examples and expected results marked **authored example**. An execution status requires actual version-matched test evidence; reference generation never runs examples or invents passed status.
- Implementation availability only where a verified owner/catalog supplies it. Otherwise say **implementation status unknown**. Passing analysis does not prove an entire workflow executes.

Do not infer current caller permission from a printed policy expression. Optional additional declaration inventories must use located facts already provided by analysis; they do not enlarge first-delivery acceptance.

Select explanatory description variants through the existing static locale resolver. Keep names, types, field selectors, operation IDs and source expressions unchanged. Shared reference headings need one reusable locale catalog; source fallback is acceptable when a heading or description is untranslated. Do not generate translations or concatenate sentence fragments.

Output must be deterministic for the same source/catalog versions and locale. Include source/catalog/language version identity, avoiding wall-clock timestamps in the body. Escape Markdown/embedded HTML so authored prose cannot inject executable content. Keep source paths project-relative in portable output. Do not embed credentials, current records or fixture values from unrelated sources; this is a local internal reference, not a publication action.

## Consumer and compatibility boundaries

The reference renderer consumes the complete shared static description value. MCP continues emitting a **source-language string** in JSON Schema/tool descriptions in this delivery. New inline literal descriptions must reach that same existing source-string path, while localized reference output retains and uses the variants. No artifact migration or connection-locale feature is needed to qualify the reference.

A later localized MCP change would resolve a complete description value using the existing connection-preference/app-default contract, preserve schema identity, version affected metadata and adapt older plain strings. It remains explicitly deferred; do not claim it complete or add a business locale argument in this scope.

IDE hover displays inline `desc=` and attached `#` from the same description slot in the source language. Resolve static references to their wording. Localized hover and an editor locale setting are outside first delivery.

Browser form help is not part of this first version. Existing localized page metadata remains working and unchanged. Reusing shared description values later is possible but is not claimed as implemented behavior.
