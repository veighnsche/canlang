# Independent enum/membership correction review

**Bounded verdict: the two retained enum-name and membership-order failures are repaired under the frozen source and focused controls. No blocker found.** This qualifies the corrections to SEM-R08/S9-Q02; it does not close either responsibility row in full.

The five source/test pins in [freeze.json](freeze.json) match the files reviewed and the pins in [review-probes.json](review-probes.json). Review writes were confined to probes and this report in `enum-membership/`; no compiler/package/shared decision/plan edits occurred.

## Source review

`TypeTable.bound_names` retains NodeKey identities from the resolver's name-binding table, excluding builtin, predicate, and error entries. IR consults the existing checked `resolved_cases` fact before spelling-sensitive fallbacks; therefore an unrelated same-spelling field or a codegen-reserved spelling does not replace an analysis-owned enum case. Enum-typed lexical names retain dynamic `IrExpr::Name` values rather than being reconstructed as spelling strings. Query/sequence/example rewrites still precede that bound-name handling. Inspection of the type claim paths shows that enum elision does not claim genuine lexical parameter/local bindings; expected builtin case spellings use the checked case fact.

Membership now emits the synchronous arrow call `(($member,$collection)=>$collection.includes($member))(LEFT,RIGHT)`. ECMAScript call-argument evaluation gives once-only LEFT then RIGHT evaluation before the collection operation, including the emitted awaits. The arrow parameters are confined to its body and cannot capture its arguments. This introduces no additional Promise continuation. Long lowering invokes the same operation on its already ordered temps, and grouped compact membership embedded in a long tree also receives the corrected order. The unsupported noncollection path still returns its throwing placeholder before lowering operands.

## Independent executions

| Control | Outcome and retained evidence |
| --- | --- |
| Exact new permanent controls | Ran `cargo test --manifest-path compiler/Cargo.toml --locked --offline --test flat_expression_runtime enum_ -- --test-threads=1`. Two passed; four filtered. [stdout](review-focused.stdout), [stderr](review-focused.stderr). The first control executes actual short/long enum(a,b) cases colliding with fields, dynamic same-spelling parameters, expected enum argument and collection contexts, compact/long/grouped/awaited membership true/false, exact left/right failure identities, and lazy skips. The second checks/compiles scenario locals and asserts their resolved slots. |
| Additional enum cases | Independently authored [review-source.can](review-source.can), checked and compiled by the actual debug CLI; [actual artifact](review-compile.stdout) is imported without modification through the real built stdlib. Case spellings `b,s,c,event,result,parent,preferences,count` execute as values. Expected scalar and enum-array derive arguments execute correctly. Same-spelling `c,b,s` enum parameters remain dynamic in short and long expressions; a nullable enum parameter remains dynamic after narrowing. |
| Awaited order/once | Additional compact and grouped-long actual consumers return both true and false with exact trace `left,left settled,right,right settled`. Each getter queues its settling marker independently. This demonstrates awaiting the first operand before reading the second; it does not claim arbitrary cross-task microtask-interleaving equivalence. |
| Failure/lazy parity | Additional compact/grouped-long consumers reject with the exact original left exception before visiting right, or with the exact original right exception after reading left. Compact and long grouped `true or MEMBERSHIP` skip both awaited operands. Coalesce skips both operands when the left is non-null `false`; null-taken coalesce executes and returns true. [Runner](review-runner.mjs), [raw Node output](review-node.stdout), [stderr](review-node.stderr), [source/runtime/binary pins](review-probes.json). |

All additional CLI/Node commands exit0 on native macOS with Node v24.21.0. The source pins were checked again after execution. The reported earlier defects are directly covered by the independently rerun permanent actual-module tests; additional reserved-name/awaited/nullish controls were authored independently of the worker's test source.

## Reused evidence and limits

The frozen worker report retains six serial runtime passes, including the unchanged 64/512/1024/2048/3000 ladder and previous arithmetic overflow/grouping/recovery controls. I validated the `final-runtime.stdout` and `.stderr` SHA256 values against `freeze.json`. I did not replay the whole unchanged ladder or the 117 codegen tests: the latter has a worker-reported pass count but `raw_receipt_retained:false`, so it is corroboration rather than independently recovered output. The exact two updated golden strings agree with the inspected lowering operation.

Scenario-local control is check/compile plus resolved emitted-slot qualification. It receives no Node runtime credit because the existing real-stdlib scenario gate exports remain absent. The actual runtime controls use derives, unmodified generated modules, and the real stdlib facade; they do not substitute gate or arithmetic mocks.

The earlier concurrent harness stdout-file-loss failure remains retained and unexplained. Successful serial runs do not diagnose or repair that harness issue. This review establishes no universal depth/host/resource guarantee, no all-operator or entire-row closure, and no arbitrary async interleaving equivalence. No new JEV decision was needed: these changes consume existing analysis authority and restore authored operand order without a new policy choice.
