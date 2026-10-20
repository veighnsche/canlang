# CRUD and record lifecycle

A `crud` declaration derives canonical create, update, and delete operations for one model. `fields` is the update allowlist and the default create allowlist; `create_fields` supplies a different create allowlist when needed. It may differ from update fields in either direction. `create=none` and `update=none` disable their respective operations. `by` controls who can call the operations, while model policies independently control reads. Omitted update fields remain unchanged; create defaults apply only on create.

## Archive, remove, and expose operations

Delete archives by default, atomically including the contained subtree. Archived rows cannot be edited or newly referenced, while authorized historical references may remain. Use `delete=remove` only when permanent removal is intended and references permit it; use `delete=none` to disable the lifecycle. `expose=` limits public selection of enabled CRUD operations, without removing enabled canonical internal operations. Omit `expose` to publish all enabled CRUD, or use `expose=none` to publish none. Explicit UI controls that contradict disabled or unexposed operations fail checking.

For a business rule requiring reasons or coordinated effects, create an authored scenario and constrain direct CRUD accordingly. See [scenarios and effects](02-scenarios-and-effects.md), [permissions](../04-Access-and-rules/02-roles-and-operation-permissions.md), and [retention](../03-Data/06-history-and-retention.md).
