# Authentication, accounts, and teams

Authentication establishes the account principal used for a request. Verified identity and account recovery are separate from team membership: a signed-in user may have no active membership in a particular team. Invitations and membership changes must be performed through the configured identity lifecycle, not inferred from a user-provided team ID.

Operations that use `members` resolve the current team and membership as part of admission. Current identity and membership facts form a trusted admission snapshot; they do not create a cross-owner transaction with unrelated storage. A completed membership removal blocks new admission. Already admitted work follows its owner fence; D1 fenced commits also detect intervening membership changes. Do not create an application-owned duplicate membership table to replace the trusted identity lifecycle.

Team ownership controls record scope; it does not automatically give every member every field. See [roles and operation permissions](02-roles-and-operation-permissions.md) and [read policies](03-read-policies-and-field-access.md). Recovery, account verification, and invitations are deployment identity responsibilities; never treat a client-supplied identity string as verified authentication.
