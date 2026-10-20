# External sync

Import external facts as proposals, compare their source revisions and reconcile conflicts before updating authoritative app records.

Keep the external identity and revision alongside the mapped app record. Define a finite mapping for fields the app accepts; do not let incoming payloads choose arbitrary model fields, permissions or operation names. Validate shape, value bounds and identity before presenting a proposed change.

An operator or authorized reviewer compares the incoming facts with current app state. Create, update or ignore through normal app operations, recording the external revision used. If a local user changed a field after the prior sync, show a conflict and require a deliberate resolution rather than overwriting the newer local value.

Deduplicate using the stable external identity and source revision. Replaying the same revision should not create a second record or repeat notifications. If the external call times out, inspect the saved sync result before retrying. A successful fetch does not mean the app update committed, and a committed app update does not mean the external source was changed.

Test duplicate imports, out-of-order revisions, malformed fields, deleted upstream records, local edits and partial failures. See [external data and app connections](../07-Integrations/06-external-data-and-app-connections.md), [deliveries](../07-Integrations/02-deliveries-and-recovery.md) and [fixtures](../09-Development/04-fixtures-and-examples.md).
