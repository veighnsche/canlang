# CSV import

CSV import maps a file or pasted table to a declared operation, previews typed rows and asks for explicit consent before applying each accepted row.

## Review before applying

Enable intake with the source fragment `form Operation import=csv`, optionally adding `review=readOperation`. The optional review is a pure read scenario returning a model-record array; its required named parameters must be a compatible subset of the target inputs/bindings. A configured review failure blocks the row. The review request identifies the operation and structural mapping. Parse the complete supplied input under configured size and row limits; report malformed rows and ambiguous headers. Convert cells using the operation’s canonical types and validations. Show a preview with field names, normalized values and row-specific errors before asking the user to confirm.

Confirmation is explicit and scoped to the reviewed preview. Only valid selected rows are eligible. Recheck current permission and invariants for every row when applying it. Each row commits independently through the canonical operation; a failure on one row does not roll back prior successful rows or silently authorize later rows. Return per-row outcomes and a resumable recovery path without exposing protected values.

Do not treat CSV as bulk database access. Import never bypasses policy, form constraints, versions or business rules. See [forms](03-forms-and-inputs.md), [transactions](../05-Workflows/03-transactions-and-concurrency.md), and [fixture examples](../09-Development/04-fixtures-and-examples.md).

## Pinned CSV profile

Input is UTF-8, optionally beginning with a BOM, with a required header, comma separators, doubled quotes and CRLF or LF record boundaries; quoted newlines are preserved. There is no delimiter or locale guessing and no formula evaluation. One review accepts at most 10 MiB and 1,000 data rows. Input is transient intake data, not an attachable file or an upload-policy bypass.

Template headers use stable input paths. Unknown/duplicate headers and overlapping mappings must be corrected or excluded. Bound parent, record and identity inputs cannot be replaced by CSV. References and expected versions use authorized reference controls; a display label does not silently choose a record. Empty nullable cells become null; nonnullable text keeps empty text and then applies constraints. Omitted columns use ordinary defaults or report required-input errors. Integers/decimals use canonical decimal text, booleans `true`/`false`, enums stable case names, and dates/instants their canonical forms. Money and references use typed leaf columns such as `amount.minor`, `amount.currency`, `customer.id` and `customer.version`; arrays/structural values use closed typed JSON. File, secret and action cells cannot supply opaque authority: use protected bindings or ordinary authorized controls.

Exact repeated normalized rows are flagged. Candidate matches come from the optional review, with no automatic merge, upsert or role transfer. Confirmation submits selected rows in source order, retaining one operation identity and frozen inputs per row. Report succeeded, failed, pending and unknown separately. Retry retains that identity; changing a successful row requires a new reviewed invocation. Before each submission, rerun the configured review: changed candidates require renewed confirmation, while unchanged matches still require the recorded explicit create decision. Review does not lock out concurrent duplicates; owning guards and uniqueness rules remain authoritative.

Draft review state is private to the authenticated user/app/team and expires after 24 hours. Logout or context loss immediately revokes access. Recover only authorized drafts; receipt retention follows its independent replay contract.
