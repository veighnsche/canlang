# Email and mailboxes

Email capabilities send reviewed durable messages and accept only verified inbound events mapped through an explicitly configured mailbox.

## Sending

Build a typed message from authorized business state, freeze the recipient and content at submission, and send it as durable work. A successful enqueue is not proof of delivery. Use the typed completion and provider reference; if the outcome is uncertain, reconcile before resending. Do not place secrets or private data in subject/body without an explicit disclosure decision.

## Incoming mail

A verified `received` event carries a typed envelope with sender, thread, subject, body, completeness indicators and finalized attachments. Treat every field and attachment as untrusted. The handler runs with its declared trusted event authority, not an impersonated browser principal; any business mutation still goes through its canonical owner and invariants.

A reviewed reply freezes source identity, recipient, message, subject, body and attachments. `accepted`, `not_sent` and `unknown` are distinct outcomes; unknown is never evidence that no send occurred. See [delivery recovery](02-deliveries-and-recovery.md) and [service contracts](../12-Reference/08-service-contracts.md).
