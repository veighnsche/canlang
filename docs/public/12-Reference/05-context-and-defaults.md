# Context and default declarations

An app may have one `context` block immediately after its app declaration. It sets only supported overrides and named resources; defaults omitted from source are inherited. Do not repeat defaults such as the standard runtime, D1 database, email/password authentication, team support, R2 file service, or base theme. Context does not create arbitrary provider configuration.

```can
# Coordinate calendar work.
app CalendarDemo
context
 binding Schedule DurableObject key=CalendarDemo.Calendar
 queue Reconcile type=ReconcileWork
 cache KV ttl=10m
 analytics Usage { event:text, occurred:datetime }
Given
 Calendar at=Schedule { name:text }
 contract ReconcileWork { calendar:Calendar }
When
Then
```

This complete declaration example owns the calendar model, queue payload type, and telemetry schema. It declares resources but no business operations or user page. A Durable Object binding names a key path that routes a root and its contained group to one authoritative SQLite owner. Queue declarations bind a name to an exact payload type; consumers are declared as trusted handlers. KV caching is positive-TTL and only for reconstructible public data; it cannot become business authority or cache private policy results. Analytics carries bounded telemetry, never transactional state.

The only additional context forms are `theme` with supported mode/accent/density values, `files` with an allowed type list and/or positive maximum size, and `locale default="..."` using a canonical BCP 47 tag. Repeated, unchanged defaults and arbitrary resource attributes are invalid. Provisioning and credentials belong to [environments and secrets](../10-Deployment/02-environments-and-secrets.md); exact syntax is indexed in [syntax reference](06-syntax-reference.md).
