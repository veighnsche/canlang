# Decimal expression and default materialization

Implemented narrow existing-owner leaf, 2026-10-08. `IrExpr::Decimal` now emits `parseDecimal(js_string(source_spelling))` with the normal deterministic `@canlang/stdlib` import accumulator. Checked `IrExpr::Int` values whose resolved scalar family is Decimal use the same constructor with exact integral text and scale0. Other Int/duration paths retain their original bigint lowering. No Number conversion, wire normalization, new catalog builtin, runtime wrapper, transport or backend policy is introduced.

`scalar_family` unwraps checked Nullable and recognizes actual scalar Decimal; Record/enum/unknown/union types do not become Decimal by spelling. Legal `derive optional():decimal? = 7` confirms the nullable contextual case. Contract/array contextual integral literals confirm the owning expected-type fact reaches the lowerer; nominal records themselves are never classified Decimal. Decimal's dotted IR spelling remains exact, including leading zeros and trailing fractional zeros. Unary minus continues to call the genuine `negateDecimal` owner and retains scale. Each leaf emits one constructor call in its original expression position; surrounding evaluation order/default gate code is unchanged.

## Source and consumer qualification

`selected.can` is the selected legal source used by the new Rust integration test. The CLI consumes the genuine installed producer catalog; Node imports the emitted modules unchanged through public package exports. `selected.artifact.json`, `generated/`, `execute.mjs` and raw `node.stdout`/`node.stderr` preserve independently rerunnable runtime evidence. The test uses the existing tempfile TempDir owner and fails if required installed owners are absent, with no substituted runtime.

Verified source-generated consumers:

- Derive return literals: leading zeros1.50 scale2, negative1.50 scale2, negative zero scale2, exact38-digit contextual integral,38-significant-digit scale18 dotted boundary, minimum nonzero scale18, nullable contextual integer and genuine Int bigint control.
- Nested nominal contract/object and Decimal array values, including contextual integral elements and unary negatives.
- Executable derive parameter default and omitted call, explicit native value identity and explicit null suppressing the undefined-only default. The explicit null call is a JavaScript gate control, not a claim that nonnullable Can source can pass null.
- Read scenario literal output; mutation parameter/output with explicit native input. Native emitted model and operation parameter default metadata contain frozen owner Decimals with the expected exact coefficient/scale.
- Authored artifact wire descriptors preserve `'1.50'` and integral `'42'`. An explicitly shown descriptor adapter takes these wire descriptors into public `normalizeSchema`; `validateValue` verifies create omission, nullable omission, explicit nullable null, explicit value replacement, nonnullable null rejection, update omission sentinels and update explicit null. `validateOperationInput` uses the source-generated operation artifact defaults for omitted/provided/null inputs, followed by genuine generated scenario invocation. This adapter is a qualification of the exported wire owner's contract, not an implemented production metadata bridge.
- Genuine public `@canlang/values/bindings/carriers` tag/reconstruct preserves150n/scale2; the emitted value encodes as wire`'1.5'` and decodes as15n/scale1. Wire normalization and source construction remain distinct.
- Real CLI rejects scale19 and39 significant digits with E3001, preserving the admitted38/18 boundary.

## Adjacent gaps preserved

The public wire/schema owner directly rejects the emitted native Decimal default with `SchemaError`, violation`type`, expected`canonical decimal string`, actual`object with keys [kind, coef, scale]`. This is explicitly asserted and printed in the raw runtime result. Materializing native metadata does not close the production default admission bridge, all creation engines, SEM06, S9Q05 or transport/backend joins.

Unary `+` is not admitted source syntax (E1215). `unary-plus.can`/stdout preserve that boundary; no parser extension is part of this leaf. Legal `action(mutate,{})` produces E6008 for the scenario reference, saved in `action-reference.can` and its rejection; this is an independent reference-value lowering gap. Attempted scalar action binding correctly rejects E3005 because action binds record parameters; its raw rejection is also saved. No action/call owner or gate was changed to remove those restrictions.

## Checks and stale oracle correction

- `cargo test --manifest-path compiler/Cargo.toml --test decimal_runtime -- --nocapture`:2 passed,0 failed. Raw `runtime.stdout`/stderr; two earlier failures are retained as `runtime-first`/`runtime-second` outputs. Those failures corrected this new test's assumption about the owner's structured error shape/code, without changing the owner.
- `cargo test --manifest-path compiler/Cargo.toml --test codegen -- --nocapture`:117 passed,0 failed. Raw `codegen.stdout`/stderr.
- Prior focused scalar run: `construct_scalars_per_op` failed at codegen.rs1688 because its exact expected Decimal division string contained throwing E6008 literal placeholders. Raw `codegen-stale.stdout`/stderr retains actual constructor output versus old claim. The separately released narrow block now asserts exact `divideDecimal(parseDecimal("1.5"),parseDecimal("0.5"))`, both imports and empty diagnostics; original equality and all other assertions are untouched.
- Independent Node run of saved CLI output passed, Node v24.21.0. No whole compiler suite, Git mutation, package build, network or JEV call.

`js.rs.before` and `codegen.rs.before` preserve selected pre-edit files; their exact patches and the new test patch are saved. Initial constructor/compiler pins and final pins show only the released js.rs/codegen.rs changed among preexisting selected inputs. Consumer source/dist/package pins are separately captured before and after the final raw Node execution and are identical. Research constructor/export evidence remains in the sibling decimal-literal-research packet. Root owns integration decisions and broader closure accounting.
