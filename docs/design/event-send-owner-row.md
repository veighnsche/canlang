# Exact event-row SEND carrier: `CanInvoice.overdue`

**Status: design only.** The current compiler still refuses guarded SENDs in
ordinary event handlers such as [`CanInvoice.overdue`](../../draft/apps/CanInvoice/CanInvoice.can):
the handler has no admitted native receipt, and `event.invoice` has no
typed SEND lexical carrier. These refusals must remain until all seams below
are implemented and tested together. This design targets the source shape
`Overdue { invoice:Invoice, revision:int }`, a leading `require`, and one
`Mail.send ... when=event.invoice.state==issued and
event.invoice.balance.minor>0`; it grants neither general event expressions
nor arbitrary handler effects. The `revision` value identifies the scheduled
event input; the authored guard does not compare it to the current invoice
version, so the implementation must not add that condition silently.

1. **Compiler.** In [`scenario_disclosure.rs`](../../compiler/src/analysis/scenario_disclosure.rs),
   admit only the complete checked handler shape and trace the exact
   `event.invoice` member to the `Overdue.invoice:Invoice` declaration and
   the same source and IR occurrence. Account for the leading `require`, SEND
   arguments, guard, and effect census; reject unrelated writes, extra
   effects, aliases, and unproved helper or query paths. In
   [`send_guards.rs`](../../compiler/src/codegen/send_guards.rs), add a distinct
   typed event-field input with declaration, event/handler identity, model,
   and source path to the free-input census. Recheck fresh source and the
   whole execution IR before emitting it. In [`js.rs`](../../compiler/src/codegen/js.rs),
   bind the original `sendWhen` Rule to that frozen model input and lower the
   predicate against it; an ambient `event` variable is not available to the
   Rule. Keep SEND site, target, binding, typed input, and Rule callables in
   the existing native correspondence inventory.
2. **Cloudflare.** The private due path in
   [`invoke.ts`](../../packages/cloudflare/src/runtime/invoke.ts) already
   validates retained Work payload and projects a model reference to identity
   for current-row hydration. Extend that admission to issue a one-shot
   event-field provenance token for the exact handler, source occurrence,
   owner scope, event field, and hydrated invoice row. Do not accept a row or
   token from the handler's ordinary inputs. The original `sendWhen` evaluator
   must receive only the State-frozen typed input and matching live Rule;
   its true verdict must remain attached to the original Work guard origin.
3. **State and Work.** In
   [`scenario-receipt.ts`](../../packages/state/src/invocation/scenario-receipt.ts),
   consume that token only at the actual current-stage owner row and SEND
   occurrence. Add a source-owner grant for this private event row rather
   than applying viewer `Invoice.read` policies (the handler has no user
   actor); this grants no returned row or viewer field access. Evaluate the
   original guard at the source stage using a frozen typed snapshot. The
   `balance` dependency is derived from `Invoice.total`, currency, credits,
   and successful payment rows, so snapshot and revalidate that complete
   bounded owner-state dependency graph, including row lifetime and event
   source identity, against final staged writes at the commit revision fence.
   A changed dependency must retry or refuse before any SEND outbox intent
   commits. Preserve [`dispatch-staging.ts`](../../packages/work/src/kernel/dispatch-staging.ts)'s
   verified true source-stage guard origin with that same atomic intent; its
   current contract retains the verdict, rather than independently running
   the predicate at later provider dispatch.

The current installed seams do not yet form this carrier. The private due
binding in [`invoke.ts`](../../packages/cloudflare/src/runtime/invoke.ts)
returns for a handler without a query plan and, when it runs, binds query and
reference producers only. The ordinary framework/SEND producer is bound over
the public operation registry before the private handler definition exists.
In [`scenario-receipt.ts`](../../packages/state/src/invocation/scenario-receipt.ts),
model SEND capture requires a row issued by the current owner session and
ordered viewer field grants from a reference producer. The scheduled handler
has no user actor, while the `Invoice` read policies require finance or an
authenticated owner. This needs a distinct source-owner event-row grant,
including proof that the Work payload's `invoice` reference was hydrated into
that exact issued row; passing an input value through the existing viewer
route cannot establish it. Finally, the SEND evaluator's model snapshot view
in [`invoke.ts`](../../packages/cloudflare/src/runtime/invoke.ts) exposes
stored `row.data` fields, not a derived `balance` getter. The original guard
therefore needs a checked derived-field evaluator and a bounded dependency
snapshot for `Credit`, successful `Attempt`, and `ExternalPayment` rows as
well as the invoice fields. Its commit fence must compare those dependencies
against final writes and the physical revision. A compiler-only event lexical
exemption would bypass these missing checks, so the original `overdue` SEND
remains refused.

An installed regression should compile the original handler and invoke it
through the real due schedule path. A current issued invoice with positive
balance queues exactly one Mail intent; a paid or unissued invoice queues
none. Negative controls must cover a forged or copied event reference,
tampered event `revision` or source occurrence, wrong model/owner/handler,
missing or changed invoice lifetime, hidden invoice with no viewer read
grant, stale payment or credit changes, a concurrent change just before
commit, mismatched Rule/source/IR, and an injected extra effect. The hidden
invoice case should still make the private owner-state decision while
returning no row to a viewer. Every failed or false case must leave no SEND
intent; a revision conflict must retry against the current state.

## Other original Invoice handler triggers

The published-main 24-source baseline has five further
[`CanInvoice`](../../draft/apps/CanInvoice/CanInvoice.can) trigger refusals,
separate from `overdue`'s SEND guard:

| Handler | Current refusal | Proof still missing |
| --- | --- | --- |
| `result on=Payments.changed` | `handler triggers have no §13 member lowering` | [`STD_PAYMENTS_V1`](../../compiler/src/analysis/catalog.rs) declares `changed` as a contract-only event with no adapter. [`ir.rs`](../../compiler/src/codegen/ir.rs) lowers only the supported Mailbox standard capability event; `Payments.changed` has no verified provider ingress, payload provenance, or `IrEventSource` carrier. Its short `emit ProviderReceipt` body does not establish a trusted trigger. |
| `collected on=Payments.collect.completed` | `standard handler triggers await the native terminal carrier` | Its first `for` predicate compares `Attempt.delivery:text?` with `event.delivery_id:text`, which the profile's same-type scalar equality refuses. Later it compares `money` amounts, writes `outcome_at=now`, reads `attempt.parent` and a derived settlement state, calls `any`, mutates the parent, and emits `settlement(attempt.parent)`. |
| `refunded on=Payments.refund.completed` | Same | It has the same nullable delivery-ID comparison; then it needs `money` equality, `now`, a parent ledger write, and a settlement emission. |
| `checkout_cancelled on=Payments.cancel.completed` | Same | Its first query predicate needs an optional delivery-reference projection, `request.cancellation?.id`; later `let attempt=request.parent` and `money` equality need checked reference hydration and value comparison before forwarding the result. |
| `reconciled on=Payments.reconcile.completed` | Same | Its first predicate needs `request.reconciliation?.id`, then the same parent-reference and result-correlation path. |

The original bounded profile had an earlier expression defect:
`expression_node` called `envelope_adjusted` on every expression, while that
helper returned `None` whenever the expression was not an `event` envelope
path. This wrongly refused even direct `row.delivery` predicates in the
existing bounded Email/Payments fixtures. The narrow fix now applies envelope
adjustment only to envelope paths; those fixtures pass, while the nullable
Invoice delivery comparison remains refused.

The compiler's [`PublicCompletionBody::collect`](../../compiler/src/codegen/ir.rs)
requires its **entire** standard-completion handler census to match one bounded
body profile. `row_leaf` currently admits scalar leaves on the directly
selected row, while `statement_for` requires a single event-correlated
`limit=1` scan. `admit_public_standard_completion` also requires a clean
whole-IR candidate before it issues the native terminal carrier, so unrelated
24-source diagnostics prevent admission even if one Invoice body is repaired.
The Work completion reader already checks the retained delivery, persisted
terminal receipt, and complete route inventory; Cloudflare re-reads that
source before and during the handler's State commit. The missing proof is an
owner-scoped compiler/body carrier for nullable correlation, checked `money`
comparison, ambient `now`, optional delivery references, parent-row
hydration and writes, derived settlement dependencies, and emitted effects.
Extending only one expression or suppressing its E6008 would leave the body
and installed source correspondence unproved. A safe implementation must
preserve the complete source census while admitting each whole owner body,
then exercise genuine consumed delivery, wrong delivery and result payload,
parent-row mutation, and revision-race controls.
Until then these five original triggers remain refused.
