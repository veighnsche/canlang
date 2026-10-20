# Instrumentation

Declare typed telemetry, bound the information it carries, and distinguish delayed or rejected analytics from authoritative business records, operation outcomes and audit history.

## Declared telemetry

Declare a named analytics stream in context, for example the declaration fragment `analytics Events {kind:text,value:decimal}`, then write only fields admitted by that schema using `send Events.write {kind="view",value=1} as attempt` inside a permitted do body. Keep events bounded and avoid direct identifiers or sensitive payloads unless the application has an explicit lawful need and retention policy. Consent and purpose govern collection.

## Interpret failures and authoritative outcomes

Analytics delivery can be delayed, sampled or rejected under quota. Record telemetry failure as telemetry failure; do not block a business commit or report analytics as proof of a payment, audit event or completed operation. Use the authoritative model/history for billing and compliance records. Retention and quotas are deployment settings. See [contracts and bindings](../08-Connect-services/01-contracts-and-service-bindings.md) and [history](../04-Model-and-query-data/06-history-and-retention.md).
