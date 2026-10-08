# Checked collection call producer

`sum` now supplies Values' required static element tag from the checked domain:
int, decimal, money or duration. Named slots retain written evaluation order and
the optional money currency follows the inserted tag. Missing or unsupported
checked element types receive E6008 instead of runtime type inference.

`any` and `all` consume the selected catalog signature's alias and scope markers.
Their checked predicate becomes a synchronous lambda whose authored alias shadows
outer bindings only inside that body. Nested aliases and reserved names retain
their owning scope. Awaited bodies receive E6008 because Values' predicate API
requires a synchronous boolean; broader async predicate support remains open.

One direct qualification passed: `cargo test --manifest-path compiler/Cargo.toml
--locked --offline --test collection_calls` (**1/1**). Fresh CLI output executes
against installed Values exports, covering all four sum families, typed empty
sums, explicit/inferred money currency, reversed named argument order and first
failure, datetime comparisons, all/any empty behavior, nested/shadowed/reserved
aliases, named and constant predicates, and awaited-predicate refusal. Money's
constructor takes major units, so three EUR produces wire minor units `300`.
Strict library Clippy passes with `-D warnings`; affected formatting/diff checks
pass. Canonical handler admission, stored arrays and invocation receipts remain
the runtime consumer owner's qualification. Completion remains **48/67**.
