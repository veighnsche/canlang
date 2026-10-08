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
S9-Q01 remains open for public presentation source-language carriage, exact
human sink admission, outbound freezing, capability and wider serving profiles.
Deployment/browser/application qualification and the historical full suite are
separately scoped.
