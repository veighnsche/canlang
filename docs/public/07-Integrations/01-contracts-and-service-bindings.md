# Contracts and service bindings

Integrations use versioned typed capabilities and explicit deployment bindings. Source declares intent and data shape; deployment selects concrete resources and credentials.

## Typed contracts

A capability declares finite operations, typed inputs and provider results, plus verified inbound events where supported. `send Capability.operation {…} as attempt` persists a typed delivery; its return is a delivery association, not the eventual provider result. The completion carries a typed result or safe error. See [service contracts](../12-Reference/08-service-contracts.md) and [delivery recovery](02-deliveries-and-recovery.md).

## Native resources

The application’s D1 database is the default business store; an explicit model `at=` can route an owner to a declared Durable Object binding. A declared typed queue uses `queue Jobs type=Work`; publish with `send Jobs.publish {value=expression} as attempt` and consume through its typed `on=Jobs` delivery handler. A `cache KV ttl=5m` binding is only for explicitly public, reconstructible presentation assets or results. Never cache permission decisions, sessions, receipts, invariants or private business authority. Cache expiry or loss must be safe because the value can be rebuilt.

Declare analytics with a named typed schema and emit through its declared write operation. Telemetry is not billing, audit history or business state. Quotas and provider resource mapping are deployment concerns. Credentials stay in environment secret bindings, never source or generated browser assets.
