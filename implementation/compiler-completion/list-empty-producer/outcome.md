# List empty-state producer investigation

Status: **design/interface mismatch confirmed; actual-list producer now refuses missing required empty message with source-anchored E6008**.

The preserved source `implementation/capability-roadmap-20261008/selected-page-refresh/Images.can` declares bare `list Job`. The supplied producer artifact `/private/tmp/canlang-repair-go-20261007/asset-mount-implementation/selected-producer/evidence/artifact.json` emits `list({context:c,model:"Images.Job",renderRow:...})` in `$can$m$496d61676573.mjs`. Its `/` descriptor export is `$can$p$496d616765733a64657363726970746f723a2f`.

## Existing contract

- `packages/contracts/src/presentation.ts:478` requires `ListProps.empty: MessageValue`.
- `packages/ui/src/collections.ts:134` passes `props.empty` to the strict `renderState` path when the authorized query returns no rows.
- `packages/ui/src/catalog.ts:38` admits authored `empty=` for list. `compiler/src/codegen/ir.rs:7234` decodes that attribute as an `IrExpr::Message`; `compiler/src/codegen/js.rs:3505` forwards decoded props. Explicit empty messages already have a producer path.
- `docs/specification/GRAMMAR.md:445` explicitly permits bare list/table declarations; DESIGN §9 includes bare collections, and the §13 expense-page target example emits a table without `empty`.
- Collection `defaults=` supplies creation/input field defaults, not an empty-state caption. No inspected normative declaration supplies baseline collection copy. DESIGN §9 explicitly says named fragment/render declarations have not been added; catalog `slot` is not reusable declaration syntax (`design/UI-COMPONENTS.md:149`).

The missing prop in this original source is therefore not lost authored information. Adding an arbitrary compiler string would introduce a language presentation default without an owning choice.

## Smallest alternatives, pending owning decision

| Choice | What it achieves | Cost or limitation |
| --- | --- | --- |
| Author `empty=` on the owning list | Uses existing syntax and strict UI contract; producer needs no new policy | Repeats copy across collections; requires source-owner choice and edit, outside this lease |
| Define one pinned language collection empty-message default, with existing `empty=` overriding it | Preserves bare-list validity and concise authoring; compiler can emit the chosen default through normal message/prop lowering | Needs an accepted owning default/copy/localization policy; none is presently specified |
| Add source-declared shared UI defaults or reusable components | Makes app-specific reuse explicit in `.can` source | New declaration, composition and scope semantics; larger than this immediate blocker, and currently unimplemented |

Prefer the pinned language default for the immediate bare-collection contract if its owning choice is accepted; prefer explicit `empty=` when product-specific copy is needed. A reusable declaration is a separate language proposal, not an existing forwarding repair.

Implementation: `lower_ui_occurrence` refuses only the actual `list` factory when decoded props have no `empty`, retaining the existing strict factory contract and existing E6008 incomplete-emission boundary. This does not choose copy or remove bare lists from the source grammar. Explicit `empty=` props still follow their existing decode/emission path. A permanent `list_empty_producer` integration test exercises absent-caption CLI refusal and source anchor, then explicit localized copy through the actual generated module, canonical authorized empty query and real UI list. The memory store is test-only; this does not claim D1 qualification.

Verification: the bounded `list_empty_producer` target passed (1 test), using `--locked --offline --jobs 2`. It confirmed source-anchored E6008 and no artifact on omission, then clean CLI output plus the actual localized UI empty state after a canonical authorized query against the test-only memory store. The earlier package-owner empty-D1 TypeError is supplied context, not a new runtime result. No foreign source, package, canonical decision or bookkeeping file was modified.

First bounded command (`cargo test --manifest-path compiler/Cargo.toml --locked --offline --jobs 2 --test list_empty_producer -- --nocapture`) reached the expected CLI refusal but failed its test-only anchor check:

```text
thread 'list_requires_empty_and_explicit_message_reaches_real_empty_query' (2574556) panicked at tests/list_empty_producer.rs:40:5:
owning source anchor
test result: FAILED. 0 passed; 1 failed
```

The existing UI span includes leading indentation. The assertion was corrected to trim that indentation while still requiring the owning `list Job` declaration. No producer behavior was changed after this failure.

Integration qualification: after the lease expanded, the two authored positive `list Item` fixtures and the direct IR list in `compiler/tests/codegen.rs` received explicit empty captions. The actual lifecycle fixture in `compiler/tests/state_machines.rs` received `empty="No jobs yet"`. Original positive factory/gate/runtime assertions and negative tests were preserved. The fourth affected bare-list case is this lifecycle fixture; inspection found three in codegen.rs. No example-owned golden source needed an edit: TeamTasks and ExpenseFlow already author empty messages.

The owning codegen target passed all 117 tests after these relevant fixture edits. The exact `compiled_lifecycle_runs_through_canonical_runtime_and_state_driven_ui` test then passed (1 test), preserving canonical creation/transitions/replay/conflict/rollback and state-driven UI. Both commands used `--locked --offline --jobs 2`; no broader suites were run. Parser/checker-only bare-list fixtures remain valid source syntax.
