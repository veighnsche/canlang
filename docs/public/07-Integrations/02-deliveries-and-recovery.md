# Deliveries and recovery

Durable deliveries preserve external intent across process failure while keeping transport status separate from business completion.

## Persisted intent

A send stores a frozen typed request and stable identity before dispatch. The returned `delivery(Target.operation)` association can be queried for status and progress. A provider completion arrives later as a typed completion envelope; handlers validate it and apply any business result through ordinary authorized operations.

## Retries and uncertainty

Queues and providers may deliver more than once or out of order. Use stable idempotency identities, sequence checks, frozen recipients/values and current-state guards. A timeout or lost receipt is uncertain, not proof of failure or success. Reconcile against the provider’s stable reference before retrying an action that could duplicate a payment, message or job. Cancellation requests do not prove the provider stopped.

External service commits are not atomic with a database transaction. Preserve pending work and report safe failure details; never claim exactly-once delivery. Typed queue publication follows the same durable intent/recovery principles. See [concurrency](../05-Workflows/03-transactions-and-concurrency.md) and [scheduling](../05-Workflows/06-scheduling-and-recurring-work.md).

## Receipt and completion fields

An associated delivery exposes immutable `id` and currently authorized `status`, `result` and `error`; observable original operations additionally expose nullable typed `progress`. Status is `pending`, `succeeded`, `failed`, `unknown` or `skipped`. There is no generic cancelled receipt status: provider-confirmed cancellation can be a domain run state. `DeliveryError` is exactly `{code:text,message:text}`, both safe required fields; it has no retryable/details/provider-body fields.

A succeeded completion carries the declared result and null error; failed carries null result and a safe error; unknown carries null result and a safe diagnostic error or null; skipped carries null result/error. Pending is a receipt, not a completion occurrence. A nullable/no-result operation follows its declared result type. Invalid provider result schemas fail delivery even if remote effects may already have occurred; failed alone therefore does not prove safe resubmission. A valid result may itself report pending or unavailable business work.

Receipt progress updates do not version or rewrite the referring business row. Replacing an association neither cancels nor erases the prior attempt. Explicit completion handlers compare the current association ID to event.delivery_id before applying current source/revision/business checks. Result redaction can later leave a succeeded safe summary with unavailable content; never rerun work to refill it.
