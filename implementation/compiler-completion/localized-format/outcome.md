# Localized formatter owner join

The compiler now consumes the checked localized `format` overload and its
source-order argument slots. Dynamic/null locales, named outer arguments,
imported message owners and declaration defaults survive lowering. The owning
checked message supplies source language and canonical parameter types; a
mechanical mapping supplies the existing Values presentation tags. Unsupported
parameter shapes refuse with E6008.

One generated adapter converts the existing UI descriptor through the public
`makeMessageDescriptor`, preserves native parameter values and calls the public
two-argument `format`. It returns the complete `{text, locale}` result. App
default comes from `c.formatting.appDefault`; admitted team timezone comes from
`c.team.timezone`, with UTC for a null team. Missing scope/team facts refuse
explicitly. Package commit b8399f5e supplies this selected-app reader/invoker
handoff; its unchanged owning qualification is reused.

Formatted output propagates through shared derives and local bindings. E6008
refuses scalar coercion, business guards/queries/writes/results/defaults and
unclassified argument/UI sinks. Pure derive returns and unused locals remain
available. The provenance walk is iterative and respects predicate/loop
shadowing. Human outbound sink classification and delivery freezing remain
unimplemented.

Direct validation:

- `cargo test --manifest-path compiler/Cargo.toml --locked --offline -j 2
  --test localized_format`: **1 passed**. The permanent consumer compiles fresh
  sources, uses the real artifact loader/assembler and installed formatter/UI
  exports, and executes the actual canonical State invoker. Two selected apps,
  French source fallback, dynamic/null locale, named/defaulted parameters,
  argument order/first failure, exact Decimal/Int/Money/Date/Datetime,
  validated text/enum/bool tags, inline wording, UTC/Brussels, missing scope and
  nine source-level business refusals pass. Real query/loop aliases shadow a
  formatted local successfully. No generated handler override is used.
- Owning codegen **117 passed** after adapter/business-boundary edits. The
  subsequent predicate-shadow correction is covered by the current consumer;
  unchanged codegen outcomes are reused. Selected-call **2 passed**, including
  plain formatting and corrected named localized formatting.
- App-locale **6 passed** after case-equivalent `NL`/`nl` composition repair;
  the first selected authored spelling is retained. Full Intl alias
  equivalence remains outside the compiler's current tag normalizer.
- Strict library Clippy (`--lib -- -D warnings`) passes after four equivalent
  match/iterator/condition style corrections. Direct behavior results are
  reused; these corrections change no emitted contract.

Earlier consumer failures were fixture/observer corrections: sections attached
to a composed app instead of its selected package, localized short year `1`
asserted as `0001`, a creation missing `as`, and a read scenario without its
required result declaration. Assertions were corrected at those boundaries;
unaffected checks were reused. Scoped Rust formatting and diff whitespace pass.

This completes the original finite SEM-R03 signature/binding owner mismatch.
The finite native text presentation/source-language carrier is qualified below.
S9-Q01 remains open for wider human sinks, outbound freezing, capability,
timezone and serving profiles.
Deployment/browser/application qualification and the historical full suite are
separately scoped.

The contextual `label` parameter profile is separately qualified by
`compiler/tests/localized_format.rs::localized_format_preserves_contextual_label_parameter_and_caption`,
using the same consumer's `--label-parameter` mode. One genuine en package/app
source reaches production CLI/catalog, actual artifact loading/module assembly
and the unchanged generated derives with the installed formatter. The native
expression host `{formatting:{appDefault:"en"},team:null}` renders the dependent
`label=seed` default as `{text:"Ready|Ready|T",locale:"en"}` and explicit
`label="Bound"` as `{text:"S|Bound|T",locale:"en"}`. A true tail-parameter
`label=caption` attribute remains checked: making that caption message
parameterized refuses exact E3016
`label cannot reference 'caption'; parameterized messages need call syntax`,
with no modules.

The first affected run failed **0/1 (0.58s)** with two E3016 diagnostics at valid
`label` parameter text types. The owning resolver now recognizes metadata only
when `label` is followed by `=`, preserving earlier-parameter default binding;
the typer uses the existing `field_parts.label` instead of scanning the declared
parameter name as metadata. Only this affected case repeated and passed
**1/1 (0.68s)**. Earlier selected-call/localized-format/branch matrices remain
reused unchanged. The earlier branch case's renamed `word` remains unchanged;
its prior contextual-name gap is qualified here. No parser or formatter facade
change, full S9-Q01, carrier/public human sink, State/authority or task-count
claim follows. Source/test/own notes are ready for scoped capture; coordinator
and Package own DECISIONS/index joins.

The finite native text presentation join is qualified by
`compiler/tests/localized_format.rs::localized_format_displays_checked_source_locale_and_frozen_result`,
using the existing consumer's `--presentation` mode: first run **1/1 (6.81s)**,
with three older tests filtered out. A compile-only build of affected
`localized_format` and `codegen` targets exited0; mechanical `IrMessage` builders
and goldens compile, with no old codegen tests or matrices executed.

`IrMessage.source_lang` comes from the checked message/module owner; missing
ownership reports E6006 without panic. One generated checked-message helper
normalizes that source tag through UI's existing `normalizeTag`, passes the
canonical fourth `UI.message` source-locale argument, and requires the returned
field to match. An incompatible older constructor that discards the fourth
argument fails `ValueError`/`invalid-construction`. Values `format` and
`makeMessageDescriptor` signatures remain unchanged. Only the `text` factory's
`values` position now admits the complete formatted pair; all other formatted
business/UI sink refusals retain their existing behavior.

One genuine imported `Shared source="FR"` package with an integer zero plural
and Dutch variant reaches production CLI, public artifact loading/assembly,
page admission/render and installed UI. Both direct message and formatted derive
render French `un` grammar with canonical `lang="fr"`. Literal braces and Arabic
remain text; HTML parameters are escaped and enclosed by FSI/PDI isolation. On
a Dutch viewer rerender, the direct descriptor becomes Dutch `andere`, while
the explicit Spanish-target formatted result remains French and frozen. Legacy
three-argument UI messages and their explicit French source option remain
supported. Carried source mismatch and malformed closed pairs reject. The
simulated old constructor must refuse the checked source postcondition, and a
formatted `badge` still refuses E6008 without modules.

Work owns the public UI/source consumer and assessment appendix; Package owns
the released contract/output join (`4304da2b`, emit0). Root owns compiler/harness
and these notes. Earlier branch/label/expression profiles and results are
reused unchanged. This finite qualification does not close full S9-Q01, wider
host/business/outbound/freezing/timezone duties or any task counter. Completion
remains 58/67 with 9 remaining references; coordinator owns DECISIONS/index.
