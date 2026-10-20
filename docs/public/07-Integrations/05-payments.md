# Payments

Payment actions require explicit user intent, durable typed requests and reconciliation of provider outcomes before recording business settlement.

## Consent and state

Collect only the amount and currency derived from the reviewed business action. Show the payer, purpose, exact amount and consequences before submission. Refund and cancellation are separate authorized operations, each with a stable provider identity and audit trail.

Provider callbacks must be verified and deduplicated before they become business events. A timeout or `unknown` state is not a failed payment; reconcile by provider reference. Record settlement only from a verified typed outcome, and keep telemetry separate from authoritative billing records. External settlement cannot join atomically with a Can record commit. See [money](../03-Data/04-money-and-currency.md), [deliveries](02-deliveries-and-recovery.md), and [transactions](../05-Workflows/03-transactions-and-concurrency.md).
