# External data and app connections

External data enters through declared mappings and is reviewed against current records before canonical operations apply it.

## Mapping and identity

Declare which external fields map to which typed application fields. Preserve the external source identity and revision needed to detect duplicates and stale updates. A source identifier is not automatically the application’s primary key, and a matching name is not proof of the same person or record.

Fetch and compare external facts outside the business transaction, then present changes and conflicts for review. Applying accepted values uses ordinary operations, permissions, constraints and invariants. Reconcile if the remote outcome is uncertain; never overwrite a newer local revision based on an older response. Cross-app calls preserve each app’s ownership and permission boundary. See [external sync](../11-Recipes/04-external-sync.md) and [composed apps](../11-Recipes/07-composed-business-app.md).
