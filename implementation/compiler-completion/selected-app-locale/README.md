# Selected-app locale producer

Implemented the bounded SEM-R03/S9-Q01 compiler producer under the accepted
[format-context policy](../selected-calls/format-context-policy/decision.md).
The existing effects module table retains raw explicit `locale_default` and
publishes a separate checked `app_default_locale`: fold the app's explicit
context and recursive resolved app membership, coalesce identical values,
diagnose incompatible values with `E2002` and both declaration spans, then
apply pinned `en`. Package selections and symbol imports contribute no context.
Diamond membership is deduplicated.

IR carries that checked value into the existing primary and authored
composition `appDefinition.appDefaultLocale` records. Authored identities and
`uses` selection remain intact. Owned changes are `effects.rs`, `codegen/ir.rs`,
the `appDefinition` paths in `codegen/js.rs`, `tests/selected_app_locale.rs`, and
narrow fixture/expected-composition adjustments in `tests/codegen.rs`.

Root ran `cargo test --manifest-path compiler/Cargo.toml --test
selected_app_locale --test codegen`: codegen **117/117 passed**, locale **5/6
passed**. The sole failure was an invalid unindented explicit-package import
fixture. Correcting its package-body indentation preserved every assertion;
root reran only `selected_app_locale`, which **6/6 passed**. The unchanged
codegen result was reused. Coverage includes pinned/default versus source
language, recursive/diamond coalescence, omission before explicit folding in
either membership order, sibling/parent conflicts and spans, import isolation,
and existing locale validity/duplicate diagnostics.

This closes compiler metadata production only. Trusted `HandlerContext`
construction, formatter bridging, runtime invocation/presentation consumption,
and source-language/runtime provenance remain broader gaps. Existing `docs.rs`
still consumes raw `locale_default` with its current source-language fallback;
inherited composition locale behavior is not migrated for that consumer here.
