# Frozen selected binding and plain format phase

The accepted selected-call/plain-format lease is implemented. Localized formatting is separately gated; SEM-R03/S9-Q01 are not claimed fully complete. No package source, shared specification, cohort entrance, state-machine owner, or Git mutation was made. Root owns acceptance/decisions/commits.

## Production contract

`TypeTable.selected_calls` retains the winning builtin overload index, resolved derive/message/role SymbolId, supplied expression anchors in source order, and declaration slots. `None` means an omitted declaration default; catalog calls have exact arity and no defaults. IR validates the owning catalog/symbol/slot closure and consumes this fact. It no longer finds the first matching arity or reconstructs generic named bindings. Missing facts emit an exact E6008 fail-closed expression.

Reordered calls capture supplied expressions once, left to right, in an array passed into a synchronous arrow. The target result is awaited outside that capture when needed. This adds no Promise for reordering and keeps argument awaits inside the original lazy branch. In-order complete calls retain direct lowering. Derived function defaults run in their owning generated function, in declaration order, only for omitted/undefined slots, with earlier parameter bindings available. Explicit null is supplied and suppresses a nullable default. Imported aliases use resolved declaration owners, including private helpers in imported defaults.

Named messages capture supplied expressions before evaluating omitted defaults in declaration order, then construct the actual UI message descriptor. Synchronous defaults use a synchronous capture. An omitted authored default that awaits a derive requires an async wrapper to await that default before synchronous descriptor construction. Supplied slots suppress default evaluation; actual descriptor params retain the correct names/types/values.

Plain `format(template,values)` uses the actual public two-argument stdlib facade. Winning checked slots also feed template/values validation: named and reversed calls diagnose missing placeholders in deterministic a/z order at the authored template span. The existing localized context-aware branch is unchanged and remains a known incompatible seam.

## Outcome evidence

`selected_calls.rs` invokes the production CLI and executes its unmodified emitted modules against the installed stdlib/UI. `implementation/probe.mjs` supplies finite direct pure-callable controls; getter inputs qualify expression evaluation, not canonical input admission. The archived `runtime/` contains exact sources, CLI stdout/stderr, emitted modules, catalog fixture and observations. There are no facade substitutions.

Controls cover positional/named/reversed plain format, template/values evaluation order, runtime format-owner errors, same-arity winning overload, exact builtin arity, required/unknown declaration slots, preserved source E2001, named/mixed getter order and first error, lazy branches, awaited argument derives, omitted/partial/hole/explicit defaults, supplied-before-default order, suppressed defaults, earlier references, null versus omission, reserved names, imported aliases with declaration-owned private defaults, message source order/first error and actual descriptor values/defaults/awaited defaults. A custom state-read catalog controls the selected target's direct and reordered await emission; reordered capture stays synchronous. Its actual scenario module import separately fails on the current absent public `require` export, so no canonical state-read invocation success is claimed.

Raw final checks: `final-gates.log` has codegen 117/117 and selected_calls 2/2. The later tightened await fixture also passes in `selected-calls.log`. `clippy.log` passes `--lib --bin can --test selected_calls --test codegen -- -D warnings`. `email-floor.log` passes the actual email admission/codec/metadata control. Earlier matching production-semantic gates passed b4_check 281/281, checked_cohort 8/8, js_binding_runtime 2/2, state_machines 4/4; recorded compactly in `checks.json`. `git diff --check` is clean. No full suite rerun was made.

`pins.json` records the binary SHA, complete compiler Rust/Cargo/build/completion inputs, actual built stdlib/UI/value formatter/catalog dependencies and tool versions. `selected-binding.patch` is the tracked production plus narrow golden delta; new test and probe are separately saved files.

## Intentional partial-artifact oracle corrections

`codegen-original.log` retains the four initial failures; `codegen-adjustment.log` and `expenseflow-missing-facts.log` retain exposed followups. Root granted only four existing golden functions/comments. The named money assertion now pins synchronous source capture plus checked declaration slots. The no-catalog control now pins the missing selected-fact stub and E6008 at count(Todo), rather than guessed synchronous code. TeamTasks pins its exact untyped BDD format observation stub/anchor while keeping typed production assertions. ExpenseFlow pins ten exact unchecked BDD call anchors, six exact dependent sequence assertion type gaps, and corresponding stub/unknown metadata, while retaining typed production/UI/recipe checks and causal operation/error/row wiring. These explicit incomplete `test_only` artifacts claim no runtime success. No checker fallback or source-example edits were introduced.

## Remaining owner closure

S9-Q07 must publish selected-call facts and types from the owning BDD observation/cell/sequence-let checker: four ExpenseFlow role observations, three first(query) let calls, three money cells/inputs, six dependent observation types, and the TeamTasks nested format/count/message observation. Current partial emission stays loud.

Localized S9-Q01 still needs the separately authorized complete app locale metadata/context/facade join. Current actual named descriptor format emits E6008; accepted positional localized output still calls format(c,descriptor,options) against the actual two-argument facade and throws invalid-construction. The earlier locale-owner report identifies app locale declarations, missing generated metadata fold, canonical Cloudflare/team timezone context loss and shared derive context forwarding. Root's later immutable HandlerContext formatting scope decision is not implemented here. Descriptor carrier/type, source-language, locale options and date/time formatting compatibility require that whole owner closure; no app/team fields or static package fallback were invented.
