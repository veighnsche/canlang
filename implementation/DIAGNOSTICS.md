# Errors, warnings and efficient AI feedback

Owner: lane 1. This policy is part of the implementation plan; exact stable code allocation lands with the first diagnostic catalog. CLI, compiler, linter and LSP consume one diagnostic engine. Editor coloring is a fallback, never an alternate parser/checker.

## Severity

| Class | Trigger | Effect |
| --- | --- | --- |
| Error | Normative parse/name/type/scope/ownership/effect/disclosure violation; invalid composition, bound inputs or example setup; required unavailable compiler/runtime capability | Block affected compilation or activation. Recover enough analysis for useful nearby diagnostics. |
| Warning: unreachable execution | The accepted control-flow rules prove a live operation path can never execute, for example after unconditional termination or a literal-false guard; exclude test-only fixtures | Does not block valid output. Identify the decisive guard and unreachable range once. Do not infer impossible business conditions from incomplete data. |
| Warning: safe but suspicious shadowing | A local declaration hides an outer same-named value actually referenced nearby, while the language permits it | Name both declarations. Exclude disjoint scopes, intentional canonical contextual names and already-invalid enum resolution. No automatic exported-identity renaming. |
| Warning: deprecated capability | A linked producer catalog explicitly marks a still-supported operation/construct deprecated and provides an applicable replacement/version boundary | Report canonical replacement and documentation. Unsupported/removed capability is an error. No invented deprecations. |
| Optional information | Proven unused pure local/private symbol; redundant equivalent defaults/guards; missing optional locale translation with valid fallback | Keep out of default build output. Aggregate by cause. Offer source-reduction hints only when equivalence and reachability are established. |

Default warnings must be demonstrated with positive and negative fixtures and actual source locations. If precise low-noise shadowing cannot be established, keep it opt-in until it can; do not emit a broad heuristic under this name. Missing read policies, absent CRUD, explicit public grants, authority reports, intentional fallback, wide lines and missing inline examples are not generic warnings. The language's defaults are valid syntax. Do not nag agents into duplicating setup, labels, operation schemas or authorization.

Bounded queries reject overflow by design. Their presence alone is not a warning or proof of a business defect. An operation that claims complete population processing requires a settled supported contract; unresolved or unsupported mandatory semantics cannot be downgraded to a harmless warning. Runtime-dependent authority/uniqueness/race rules remain enforced at runtime rather than guessed statically.

## One compact machine format

Use a versioned diagnostic result containing tool/language/schema versions, source revision hashes, analysis completeness, ordered diagnostics and truncation metadata. Each diagnostic has stable code, severity, concise message, primary `{file,startByte,endByte}`, optional related spans/messages and documented tags. UTF-8 byte offsets are canonical internally; a shared line index converts to the LSP negotiated position encoding. Do not build a second Unicode implementation.

Suppress derivative cascades after an unknown symbol or invalid type. Group repeated consequences and link their root declaration. Errors remain distinguishable from an incomplete/cancelled analysis. `can check --format=json`, `can lint --format=json`, `can explain CODE --format=json`, `can fmt --check` and `can lsp` are the intended single-binary surfaces; exact argument parsing belongs to lane 1. JSON stdout is parseable, progress goes elsewhere, exit status distinguishes diagnostics from tool failure. Optional limits must disclose omitted diagnostics, never suggest a clean file.

LSP supports current-document diagnostics, completion, hover/signatures, definitions/references, rename, semantic tokens and code actions over the same analysis. Cancel stale requests; publish only for their source versions. No warnings from a different unsaved buffer may be presented as current. Agent inspection should expose the real canonical signature/default/permission context concisely, with provenance, rather than making an agent read the entire design book for each edit.

## Fixes and formatting

Request fixes separately to keep normal output short. A code action contains an ID/title/kind, safe-or-review applicability, and edits carrying expected content hashes and byte ranges. Reject stale edits and recompute. Diagnostics carry no executable shell commands. Automatically safe fixes preserve meaning; permission grants, removing guards, business defaults, deployed identity changes and destructive migrations always require a substantive authored decision, never a lint autofix.

Formatting uses the lossless CST and is idempotent. Preserve descriptions/comments, inline translations, strings, exact values, evaluation order and Given/When/Then identity. Use one-space indentation and keep newlines only where grammar or meaningful readability needs them. It is not a code simplifier, import reordering engine or policy repair tool. Removing an apparently unused binding is unsafe if its initializer can fail or its import changes executable dependency closure.

Measure usefulness with a small repeatable task set: add a field and page binding, correct a type/reference, change an operation parameter with consumers, repair a stale action and inspect a denied operation. Track actionable diagnostics, invalid-fix rate, edit turns and output tokens when measurements exist. Do not claim better agent efficiency from shorter messages alone or run endless model benchmarks instead of implementing the required tools.
