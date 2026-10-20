# Invariants and locks

An invariant checks a property of the final provisional state for every write path at its owner. Use it for requirements that must hold regardless of which CRUD operation, scenario, hook, or package call changed the data. A lock evaluates its condition on pre-state, protects selected field values, and prevents removal of the protected row. An omitted condition means always locked. The transition establishing a conditional lock may still set the final values; archival preserves locked values.

Guards on one scenario explain whether that operation is eligible. They do not replace owner-wide invariants. Hook rewrites are included before invariant evaluation; failure rejects and rolls back the mutation. Locks and invariants must remain local to one authoritative storage owner, because a cross-owner check cannot be atomic.

Design rules to fail closed with safe errors and bounded work. An expired record's declared retention can dispose of locked evidence, but does not permit a field edit or premature removal. See [scenarios](../05-Workflows/02-scenarios-and-effects.md), [transactions](../05-Workflows/03-transactions-and-concurrency.md), and [history and retention](../03-Data/06-history-and-retention.md).
