# Events, hooks, and queue consumers

Precommit CRUD hooks observe the proposed change and may reject or adjust a create/update before invariants, locks, and commit. At most one hook exists for each model CRUD operation. Hooks cannot call back into their triggering CRUD. Rules that must cover all write paths belong in owner invariants or locks.

## Handle committed events separately

A committed event is emitted with its source mutation and handled later in a separate owner transaction. It cannot retroactively reject the source. Event handlers are trusted scenarios whose input comes from a verified source, not client parameters. Queue consumers receive only the declared typed payload and verified ingress context. Queue delivery can duplicate or reorder; stable occurrence identity and canonical receipt replay prevent completed child work from being repeated.

Never infer an event from a scenario or enum name. Store any values that must survive as explicit event fields; a record ID resolves under current authority and may now be unavailable. Queue declarations and their exact types are in [context and defaults](../12-Reference/05-context-and-defaults.md); external transport recovery is in [deliveries](../07-Integrations/02-deliveries-and-recovery.md).
