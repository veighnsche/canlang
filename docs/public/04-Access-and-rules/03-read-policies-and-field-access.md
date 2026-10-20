# Read policies and field access

Read policies control which rows and fields a caller may observe. No policy means deny. A row policy establishes eligible records; matching policies union their field grants for matching rows. Omitting `fields` grants ordinary fields and safe metadata, never secrets. Field grants limit which leaves and dependencies are readable. Querying a related record or deriving a value does not bypass the policy on its source. A page, collection, form, export, generated tool, and replayed result must project the same current authority.

## Field selectors and safe projections

Explicit leaf selectors can descend through singular embedded typed values, but never through model/user/member references, arrays, JSON, files, secrets, or actions. A leaf grant supplies only that leaf and required nullable-prefix presence; granting a derived field still requires its exact readable dependencies.

Unreadable rows are omitted from ordinary lookup and list surfaces. An opaque record ID supplied to a mutation grants no read privilege; the canonical write guards still run, and rejection uses a generic safe failure rather than returning confidential values. A denied read must not distinguish hidden records from nonexistent ones. Mutation result projections are checked against current access, including when replay returns a previously saved outcome.

A presentation `require` can hide a row or control using readable projected data, but is not a substitute for operation admission. See [queries](../03-Data/03-queries-and-aggregates.md), [roles](02-roles-and-operation-permissions.md), and [invariants and locks](04-invariants-and-locks.md).
