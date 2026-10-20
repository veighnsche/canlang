# Instrumentation

Typed analytics and operational signals help measure application behavior without becoming authoritative business records.

## Declared telemetry

Declare a named analytics stream in context, for example the declaration fragment `analytics Events {kind:text,value:decimal}`, then write only fields admitted by that schema using `send Events.write {kind="view",value=1} as attempt` inside a permitted do body. Keep events bounded and avoid direct identifiers or sensitive payloads unless the application has an explicit lawful need and retention policy. Consent and purpose govern collection.

Analytics delivery can be delayed, sampled or rejected under quota. Record telemetry failure as telemetry failure; do not block a business commit or report analytics as proof of a payment, audit event or completed operation. Use the authoritative model/history for billing and compliance records. Retention and quotas are deployment settings. See [contracts and bindings](01-contracts-and-service-bindings.md) and [history](../03-Data/06-history-and-retention.md).
