# Exact event-row SEND carrier: `CanInvoice.overdue`

**Status: implemented for the original `CanInvoice.overdue` handler.** The
compiler now admits its guarded SEND with a native receipt and typed
`event.invoice` carrier. This bounded profile targets the source shape
`Overdue { invoice:Invoice, revision:int }`, a leading `require`, and one
`Mail.send ... when=event.invoice.state==issued and
event.invoice.balance.minor>0`; it grants neither general event expressions
nor arbitrary handler effects. The `revision` value identifies the scheduled
event input; the authored guard does not compare it to the current invoice
version, so the installed decision does not add that condition.

The numbered design below records the proof obligations implemented across
Compiler, Cloudflare, State, and Work. The installed
[`native-invoice-overdue` integration](../../packages/cloudflare/src/runtime/native-invoice-overdue.integration.test.ts)
passes the real due path with positive and paid balances, later ledger changes,
a hidden Invoice, a commit race, and provider dispatch after a later payment.
Eight altered-source variants remain refused.

1. **Compiler.** [`invoice_overdue_decisions.rs`](../../compiler/src/codegen/invoice_overdue_decisions.rs)
   verifies the complete original handler, three balance derives, fresh IR,
   and one guarded Mail effect. [`send_guards.rs`](../../compiler/src/codegen/send_guards.rs)
   binds `event.invoice` to the declared event field as a typed lexical input.
   [`js.rs`](../../compiler/src/codegen/js.rs) runs the original `require` and
   SEND body with the State-supplied balance; the Rule receives that same
   frozen model input.
2. **Cloudflare.** The private due path in
   [`invoke.ts`](../../packages/cloudflare/src/runtime/invoke.ts) binds one
   source-bound callback to the retained Work event and current Invoice. It
   supplies the State-owned balance to the original body and source-stage
   Rule, while dispatch verifies the persisted true guard origin.
3. **State and Work.** [`scenario-receipt.ts`](../../packages/state/src/invocation/scenario-receipt.ts)
   grants the due owner its current Invoice without a viewer read grant,
   computes the exact Money balance from complete bounded child domains,
   and rechecks them with the Invoice and physical revision before committing
   Mail. [`dispatch-staging.ts`](../../packages/work/src/kernel/dispatch-staging.ts)
   retains the verified source-stage verdict with the intent; provider
   dispatch does not independently evaluate the later balance.

The installed carrier issues an owner-scoped current Invoice from retained due
Work, computes `balance` from complete `Credit`, `Attempt`, and
`ExternalPayment` child domains, and rechecks all rows and domains at commit.
It gives the original body and Rule the same derived value without granting
viewer access. False original `require` paths record failed due Work with no
Mail. Dispatch retains the verified source-stage true verdict rather than
recomputing a balance that may change after the intent was queued.

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
