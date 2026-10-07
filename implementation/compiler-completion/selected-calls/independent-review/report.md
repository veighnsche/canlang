# Independent review: frozen selected binding/plain format phase

**Result: ACCEPT the bounded phase. No blocking finding in the reviewed implementation. SEM-R03/S9-Q01 remain OPEN as whole findings.**

The reviewed checkout is `f7566ce3bc71d330352d397245ec4a95f241ae10` plus the archived `reviewed-production.patch` and the separately pinned new test/probe. The production CLI was copied before any other build and executes with SHA-256 `b8ec81900121effeab3b2145c0f4436089eeea7a273642317335309861c0cd3d`. All 59 implementation input hashes matched the implementation packet during review; `pins.json` records them, the independently generated artifacts, and the reproduction command. The frozen executable is in temporary scratch, not part of the repository evidence.

## Source review

I read AGENTS.md and the production diffs in `analysis/types.rs`, `codegen/ir.rs`, and `codegen/js.rs` before reading author conclusions. I then reviewed `tests/selected_calls.rs`, its actual runtime probe, all four modified `tests/codegen.rs` functions, the author report, and the focused raw receipts.

The selected call fact retains the winning catalog overload index or resolved declaration SymbolId, supplied argument anchors in source order, and declaration-order slots. Only declaration calls may have omitted slots. Builtins still match exact producer catalog arity. `finish_builtin_call` receives winning slot-ordered arguments/types, including plain format validation. IR uses those published facts rather than choosing an overload by arity or rebinding names. It validates complete slot coverage, unique argument references, argument anchors, and target-owned slot arity/default availability. Missing facts produce the precise E6008 stub. The public codegen entrance still enforces checked cohort identity and rejects incomplete analysis without its explicit test-only acknowledgment.

Reordered supplied arguments lower into a source-order array consumed by a synchronous arrow; awaited target results remain outside that arrow. The array and argument awaits stay at the original expression location, preserving lazy branches and first-error order. Complete in-order calls retain their direct form. Derive defaults execute in declaration order inside their declaration-owned generated function, guarded by `===undefined`; earlier parameters are available and explicit null suppresses defaults. Message defaults follow captured supplied expressions, bind each parameter in order, and use an async wrapper only when an authored omitted default itself requires awaiting. Resolved imported owners and encoded bindings preserve alias and reserved-name behavior.

Plain format uses the installed two-argument public facade with winning template/values slots. Localized format remains an explicitly excluded legacy branch; it still reconstructs its old localized arguments. This branch is not accepted as selected-slot closure or repaired localization.

## Independent execution

`controls.mjs` compiles distinct authored sources through the frozen production CLI and imports the unmodified emitted modules using the actual installed stdlib/UI. Every emitted module also passed real `node --check`. `controls.log` records success; `observations.json` and per-case sources/stdout/stderr/modules preserve ten compile/gap receipts.

The controls verify:

- A second builtin (`contains`) with same-arity overloads distinguished by types, then by different parameter names. Actual runtime output confirms the second winning declaration order is consumed.
- Reversed, mixed, and nested derive/builtin argument evaluation exactly once in source order, first thrown error, and an untouched lazy branch.
- Three declaration defaults referencing earlier parameters, omitted holes, and supplied-null versus omitted nullable derive values.
- Reserved `c`/`class`/`await` message bindings and actual descriptor parameter names/types/values; imported aliases resolve private declaration-owned defaults despite a same-named caller helper.
- Reversed plain format inputs, escaped braces and non-ASCII values, dynamic missing/malformed template errors identical to the actual public owner, sorted/deduplicated missing-placeholder diagnostics, and exact authored template spans.
- Exact builtin arity failure remains E3005 without an invented default or E6008 fallback.
- State-read selection preserves syntactically valid await inside a lazy branch and a synchronous capture. Actual import separately fails on the installed absent `require` export; the test records that limitation rather than replacing a facade.

Initial independent fixture assumptions were corrected before final qualification: the real catalog has `contains`, not `ends_with`; message parameters reject nullable types (E5009); canonical diagnostics deduplicate repeated missing placeholders. These were fixture errors, not production findings. Final rerun passed.

## Existing receipt and golden review

I reused the matching pinned evidence rather than running a new full suite. `final-gates.log` records codegen 117/117 and selected_calls 2/2, including the actual runtime suite bodies. `selected-calls.log` records the tightened later runtime fixture. `clippy.log` records strict lib/bin/selected_calls/codegen success, and `email-floor.log` records email admission 1/1. The implementation packet also records matching earlier b4_check 281/281, checked_cohort 8/8, js_binding_runtime 2/2, and state_machines 4/4. These are reused author receipts, not newly executed independent Rust runs.

The four golden support updates are honest and remain narrow. The named money test pins a synchronous source-order capture. The no-catalog test pins the owning `count(Todo)` E6008 missing-fact anchor and throwing stub. TeamTasks pins its one exact untyped BDD format observation gap. ExpenseFlow pins ten exact unchecked BDD call anchors, six exact downstream sequence observation-type gaps, the expected throwing stubs and unknown metadata. Existing production/UI/operation/error/recipe structure assertions remain. These explicitly incomplete test-only golden artifacts make no runtime claim; accepting their fail-closed evidence does not accept the missing BDD owner publication.

## Remaining limits

Localized format metadata/context/descriptor/provenance and the actual public localized facade join remain OPEN. BDD check-call/type publication remains OPEN, including the exact golden gaps above. Canonical scenario state-read invocation and context forwarding were not qualified because actual module import stops at the missing stdlib `require` export. Direct getter-bearing external contract fixtures qualify expression evaluation only; they do not establish canonical public input admission. Custom catalog controls qualify selection/slot authority, not new public catalog signatures.

No production, shared documentation, package, Git, or test-suite changes were made by this reviewer. No broad suite was rerun. Root owns later fixes, accepted decisions, commits, integrated suite execution, and eventual whole-finding closure.
