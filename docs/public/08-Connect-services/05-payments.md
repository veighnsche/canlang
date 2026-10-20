# Payments

Collect a reviewed invoice amount, retain verified payment observations and request one full refund. Use sandbox data to distinguish checkout, settlement and uncertain outcomes before taking another action.

## Consent and state

Collect only the amount and currency derived from the reviewed business action. Show the payer, purpose, exact amount and consequences before submission. Refund and cancellation are separate authorized operations, each with a stable provider identity and audit trail.

Provider callbacks must be verified and deduplicated before they become business events. A timeout or `unknown` state is not a failed payment; reconcile by provider reference. Record settlement only from a verified typed outcome, and keep telemetry separate from authoritative billing records. External settlement cannot join atomically with a Can record commit. See [money](../04-Model-and-query-data/04-money-and-currency.md), [deliveries](02-deliveries-and-recovery.md), and [transactions](../06-Business-workflows/03-transactions-and-concurrency.md).


## Prepare a payment sandbox

`PaymentDemo` is a complete, deliberately narrow invoice workflow: one collection and at most one full refund per invoice. It has no automatic charging, partial refunds, tax engine, subscription logic or automatic replacement attempts. Use a sandbox implementation of `std.PaymentsV1` bound as `deployment.payments`; the operator must configure merchant/team namespace, server-side credentials, authenticated callbacks and provider idempotency/reconciliation mapping.

Assign the app's finance role to the test member and obtain a real sandbox customer identifier from that configured adapter. `customer-demo-001` below is illustrative; it must map to a synthetic customer in your sandbox. Do not use production funds or credentials for the walkthrough.

## Use the complete invoice source

Save [PaymentDemo.can](../examples/files-mail-payments/PaymentDemo.can):

```can
# Collect and fully refund one reviewed invoice in a payment sandbox.
app PaymentDemo
use std {PaymentsV1 as Pay,PaymentState} from=deployment.payments
Given
 role finance
 Invoice {customer:text trim min=1,purpose:text trim min=1,total:money,collection:Attempt?,refund:Attempt?,needs_review:bool=false}
 Attempt in Invoice {kind:enum(collection,refund),reference:text unique,amount:money,collection:delivery(Pay.collect)?,refund:delivery(Pay.refund)?,reconciliation:delivery(Pay.reconcile)?,snapshot:PaymentState?}
 policy Invoice read=finance
 policy Attempt read=finance
 invariant Invoice: row.total>money(0,row.total.currency)
 invariant Attempt: row.snapshot==null or (row.snapshot.reference==row.reference and row.snapshot.amount==row.amount)
 lock Invoice fields=customer,purpose,total when=row.collection!=null
 lock Attempt fields=kind,reference,amount,collection,refund
When
 crud Invoice by=finance fields=customer,purpose,total when=row.collection==null delete=none
 scenario collect(invoice:Invoice) by=finance
  require invoice.collection==null
  do
   create Attempt {parent=invoice,kind=collection,reference=operation.id,amount=invoice.total} as attempt
   send Pay.collect {customer=invoice.customer,amount=attempt.amount,reference=attempt.reference,consent=null} as request
   set attempt {collection=request}
   set invoice {collection=attempt}
 scenario refund(invoice:Invoice) by=finance
  require invoice.collection!=null
  require invoice.collection.snapshot?.status==succeeded and invoice.refund==null
  do
   let payment=invoice.collection.reference
   create Attempt {parent=invoice,kind=Attempt.kind.refund,reference=operation.id,amount=invoice.total} as attempt
   send Pay.refund {payment,amount=attempt.amount,reference=attempt.reference} as request
   set attempt {refund=request}
   set invoice {refund=attempt}
 scenario reconcile(attempt:Attempt) by=finance
  require attempt.reconciliation==null or attempt.reconciliation.status!=pending
  do
   send Pay.reconcile {reference=attempt.reference} as request
   set attempt {reconciliation=request}
 scenario collected on=Pay.collect.completed
  do
   for attempt in Attempt as item where item.collection?.id==event.delivery_id limit=1
    if event.status==succeeded and event.result!=null
     require event.result.reference==attempt.reference and event.result.amount==attempt.amount
     if attempt.snapshot==null or (event.result.revision>attempt.snapshot.revision and attempt.snapshot.status!=succeeded)
      if attempt.snapshot?.status==failed and event.result.status==succeeded
       set attempt.parent {needs_review=true}
      set attempt {snapshot=event.result}
 scenario refunded on=Pay.refund.completed
  do
   for attempt in Attempt as item where item.refund?.id==event.delivery_id limit=1
    if event.status==succeeded and event.result!=null
     require event.result.reference==attempt.reference and event.result.amount==attempt.amount
     if attempt.snapshot==null or (event.result.revision>attempt.snapshot.revision and attempt.snapshot.status!=succeeded)
      if attempt.snapshot?.status==failed and event.result.status==succeeded
       set attempt.parent {needs_review=true}
      set attempt {snapshot=event.result}
 scenario reconciled on=Pay.reconcile.completed
  do
   for attempt in Attempt as item where item.reconciliation?.id==event.delivery_id limit=1
    if event.status==succeeded and event.result!=null
     require event.result.reference==attempt.reference and event.result.amount==attempt.amount
     if attempt.snapshot==null or (event.result.revision>attempt.snapshot.revision and attempt.snapshot.status!=succeeded)
      if attempt.snapshot?.status==failed and event.result.status==succeeded
       set attempt.parent {needs_review=true}
      set attempt {snapshot=event.result}
 scenario changed on=Pay.changed
  do
   for attempt in Attempt as item where item.reference==event.reference limit=1
    require event.amount==attempt.amount
    if attempt.snapshot==null or (event.revision>attempt.snapshot.revision and attempt.snapshot.status!=succeeded)
     if attempt.snapshot?.status==failed and event.status==succeeded
      set attempt.parent {needs_review=true}
     set attempt {snapshot=event}
Then
 page / title="Sandbox invoices" poll=2s
  form Invoice.create display=inline
  list Invoice columns=customer,purpose,total,needs_review
   edit
   action collect
   action refund
   list Attempt columns=kind,amount,collection.status,refund.status,reconciliation.status
    text row.snapshot?.status,row.snapshot?.failure
    link target=row.snapshot?.checkout_url caption="Open checkout"
    action reconcile
```

Run `can check PaymentDemo.can`, then, with the binding configured, `can dev ui --root . --source PaymentDemo.can --app PaymentDemo`. Check the serving revision and open as the finance member.

Only finance can create/read/update invoices or start collection, refund and reconciliation. Invoice details lock once collection begins. Attempts have no public CRUD; source, amount and original delivery are immutable. A send and its stored association commit with the owning business operation, not with external settlement.

## Collect the reviewed amount

Create this invoice through its canonical form:

| Input | Synthetic value |
| --- | --- |
| customer | The configured sandbox equivalent of customer-demo-001 |
| purpose | Documentation stationery DEMO-001 |
| total | EUR 12.50 |

The source value is `money(12.50,"EUR")`; canonical JSON money is `{"minor":"1250","currency":"EUR"}`. Review customer, purpose and exact amount before choosing collect. The operation reads the invoice's frozen total rather than accepting an unrelated amount from another control.

It creates a collection Attempt with a stable logical reference, sends Pay.collect and stores the collection association. `consent=null` requests ordinary interactive checkout. It does not assert an automatic-charge mandate. If the verified PaymentState supplies a checkout URL, Open checkout uses that typed URL; absent URLs remain unavailable rather than being fabricated.

Complete checkout in the sandbox. A redirect or succeeded delivery alone does not mark the invoice paid. The app presents verified `snapshot.status`; only succeeded PaymentState is settlement evidence. If it stays pending/unknown, reconcile the same Attempt reference.

## Apply verified observations without double-counting

Completion handlers match their stored delivery IDs and require the expected payment reference and amount. The standard Payments.changed event carries PaymentState directly, so its handler uses `event.reference` and `event.amount`. This differs from custom events that explicitly wrap a value field.

Only newer provider revisions replace unsettled observations. Duplicate/older events do not rewrite them, and succeeded evidence is retained. A verified later success after an earlier failed observation is kept and marks `Invoice.needs_review=true`; it must not be discarded to preserve the earlier failure claim. The sandbox adapter must also enforce reference/kind/account/amount correspondence and consistent equal-revision content.

Receipt status and domain payment status are separate. Receipt updates alone do not version the referring business row; the explicit handler snapshot update does. The page polls authorized reads, without initiating collection or refunds.

## Request one full refund

Once the collection snapshot is succeeded, choose refund after reviewing the amount and consequence. The operation uses the original collection's logical reference as payment, creates a separate refund reference and sends exactly the invoice total. The refund is a new external operation with its own receipt and observations.

The `invoice.refund==null` guard prevents a second full refund through this app, including while the first is pending or unknown. It does not guess that a failed transport permits another refund. Observe or reconcile that existing refund Attempt until its outcome is established.

A provider cancellation is different: `cancel(reference)` disables new checkout use, not a refund of confirmed funds, and uncertainty can remain. The sample intentionally supplies no cancellation operation or automatic retry policy. Extend those only with explicit business rules and the [standard contract](../13-Language-reference/04-service-contracts.md#mail-payments-and-errors).

## Recover uncertain collection or refund outcomes

| Situation | Safe next step in this app |
| --- | --- |
| User submission response was lost | Replay the original operation identity/inputs; do not create another invoice/attempt to recover it |
| Checkout returned but PaymentState is pending/unknown | Reconcile the original collection reference |
| Delivery failed after possible provider acceptance | Inspect/reconcile; failed transport does not prove no funds moved |
| Refund request is uncertain | Reconcile that refund reference, not the collection and not a new refund |
| Reconciliation itself is pending | Wait for that observation; the guard blocks a second pending reconciliation |
| A late verified success contradicts earlier failure | Retain the money evidence and review the marked invoice |
| Proven failed collection needs a genuinely new attempt | This narrow app has no replacement-attempt workflow; author one with explicit intent, limits and a new identity |

An adapter's failure classification is meaningful only for a definite failed outcome. Unknown does not become transient/action_required/permanent/cancelled merely to justify a retry. Keep frozen amounts, currency and identity when reconciling; never infer settlement from telemetry or a human-readable message.

## Verify the sandbox workflow

Collect EUR 12.50 and observe a verified succeeded collection. Request its full refund and verify the separate refund settles; a second request must be refused. Repeat on a different synthetic invoice with a deliberately lost provider response, using reconciliation rather than a new collection. Deliver duplicate and older revisions and confirm they cannot undo newer evidence. Exercise a contradictory late success and inspect needs_review. Verify an ordinary member cannot invoke finance operations or read these records.
