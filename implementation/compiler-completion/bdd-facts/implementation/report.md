# Owning BDD expression facts — S9-Q07

The owning analysis now publishes expression types and selected-call facts for the checked BDD positions exercised by the original TeamTasks and ExpenseFlow examples. Production `b1_join` passes unchanged: TeamTasks has exactly its two existing UI gaps, ExpenseFlow has zero lowering gaps. No example source or production join oracle changed.

## Implementation

`resolve_example_headers` retains the original fixture/production namespace for common header values, then supplies the enclosing action inputs/result (and validated trusted event binding) to row and sequence expressions. Input headers remain E5 selector vocabulary: known lexical roots receive normal expression scopes, while caller and request-envelope profiles remain with their existing owner. General BDD expressions use the common resolver walker, including query aliases and ordered sequence lets. Sequence calls advance a child result scope in source order; a rejected call poisons result availability and declared `as` bindings reuse the resolved operation result context. Production privacy resolution and E5 call/request/caller validation remain authoritative.

`check_example_headers` uses the existing `expr`, `type_call`, overload selection, declaration-slot/default binding, and `stmt_let` implementations. It records observation/input/cell expression types, passes column expectations to expected values, and visits sequence argument/request objects and lets in order. True assertion continuations use the existing narrowing extractor for later sequence observations. There is no BDD call checker, IR guessing, catalog arity fallback, or source rewrite.

The documented runner/E5 unresolved-name profile of general BDD expressions is retained by restoring only their newly accumulated unresolved-name queues after the common walk. Common header and production unresolved diagnostics retain their original ownership; helper/call catalog diagnostics are not removed. Known expressions acquire real facts; unknown callees acquire no fabricated selected binding. This is a bounded publication repair, not a claim that every general runner input or expression now has complete compiler type checking.

A transient single-root implementation let enclosing action parameters mask unavailable imported fixtures in common headers. The two-root correction restores the original errors and all draft outcome counts. `header-scope-receipt.json` pins the three affected E2001 sites (CanCreative conversation twice, CanGallery output once); raw count failures and final passing analysis output are retained. Added generic parameter expectations on common headers were removed as independent scope; the prior validated on_event expectation remains.

## Verified

`final-gates.log` records analysis 37/37, unchanged b1_join 2/2, b4_check 281/281, b4_examples 25/25, bdd_binding_runtime 1/1, initial bdd_checked_facts 1/1, codegen 117/117, selected_calls 2/2, typed_bdd 2/2, UI adapter 1/1. `final-closure-gates.log` subsequently passes b1_join 2/2, expanded BDD facts/error-ownership tests 2/2, codegen 117/117, selected_calls 2/2 and UI adapter 1/1. The new regression pins actual catalog/original ExpenseFlow call anchors and sequence enum/bool types, preserves common-header/production E2001, and distinguishes a checked known callee from an unknown observation callee. `final-clippy.log` checks the final lib/bin/new facts test/codegen with warnings denied. No full suite was run by this worker.

The root-reviewed golden restoration touches only `golden_expenseflow_structure`: checked role/money/query output, concrete enum/user? assertion metadata, zero E6008, and absence of hidden placeholders/unknown metadata. Its fixture catalog marks first state-read and therefore pins await first; the actual catalog marks first pure. Both consume their checked owning catalog, with no emission guess. Other previously adjusted goldens are unchanged.

`before-b1_join.log` preserves the genuine pre-fix 3-versus-2 TeamTasks and 16-versus-0 ExpenseFlow failures. `first-b1_join.log` is a concurrent UI intermediate-source compile probe, not a final product regression. Early regression logs preserve resolved scope and test-anchor/qualification mistakes. `source.patch`, copied regression source, proposal diff, original source compile artifact, and final manifest make the final change reviewable.

## Qualification and limits

Actual installed catalog/dists and unchanged generated modules are used. The selected-call runtime regression executes the public stdlib/UI facades; the BDD binding runtime regression executes actual testkit load/provision/observation/causal-step code through an invocation port. That test explicitly does not execute application operations against a canonical state engine. The UI adapter receipt comes from its separate owning worker and is included in the frozen shared build.

Zero ExpenseFlow emission gaps do not prove complete ExpenseFlow runtime execution. The subject-role facade still rejects unsupported noncaller subject checks in the current producer, and query/read/canonical application joins remain independently owned. No mock state engine, facade substitution, or guessed fallback is presented as full seam proof. A frozen CLI is copied only to `/private/tmp/can-bdd-ui-review/can-frozen`; the repository contains no binary. `final-manifest.json` records its SHA, version, complete compiler inputs and actual relevant package dists. Root owns acceptance, decisions, Git and final integration.

## Sequence request forwarding follow-up

The compiler already emits the declared optional `request(c,s,b)` closure. The
existing runner now evaluates it once, after caller and inputs and before
invocation, through the same contextual `callClosure` path and fixture/binding
facades. Its evaluated value passes unchanged through `StepCall` and the existing
dispatch adapter. Absent closures leave the request member absent. Business input
objects, caller selection, success/error envelopes and `as` bindings retain their
existing behavior. Applying version overrides remains with the actual invoker;
this repair supplies no new wire codec or authority.

The focused `authored_sequence_requests_reach_the_dispatch_adapter` test compiles
actual source and loads its unchanged example module through public testkit. It
checks a fixture version override, a prior reserved-name binding override,
expected conflict handling followed by success, exact business-record identity,
input/request/dispatch order, evaluate-once behavior, absence preservation and a
request exception preventing dispatch with the authored step index. It passes
**1/1** against a private build of the changed testkit; direct testkit TypeScript
checking also passes. An initial event probe incorrectly assumed caller bindings
were reread after factory capture; that expectation was corrected, while actual
caller identities remain checked. Accepted property-carrier/order controls are
reused rather than rerun.

This closes request evaluation/forwarding through the invocation port only.
Canonical application version application, real result payload/inspection/as
semantics, live record refresh, helper composition and wider platform joins remain
open under their existing owning contracts and narrow BDD consultation hold.
Canonical completion remains **48/67**.

## Finite imported-helper link

`compiler/tests/bdd_binding_runtime.rs::imported_example_helpers_use_actual_production_registry` passes **1/1** (0.90s) from the unchanged captured `sequence-alias.can` through the current CLI, installed catalog, generated production/test modules, and installed testkit setup/invoke/observe path. The selected `Provider.take` alias executes its actual production registry entry: the preceding echo dispatch and expected assertions succeed. The existing `{ok:true}` invocation-port profile is preserved.

The owning compiler change is finite: the JS emitter tracks checked canonical helpers used by generated examples, and the BDD emitter links those helpers to the already-exported production `canApp` registry entries only when needed. Production helper bodies stay in their owning module, with existing transitive/default closure. Focused codegen and BDD-binding `--no-run` build passed (13.37s); no broad suite or old case was rerun. This closes only the imported-helper link for this actual alias. BDD3 payload/result/`as`, live refresh, context/disclosure, and input-slot policy remain held; no full S9-Q07 or reference-count credit follows. Original completion remains **58/67**, with **9 open** references.
