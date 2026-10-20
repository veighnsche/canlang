# CSV import

CSV import maps a file or pasted table to a declared operation, previews typed rows and asks for explicit consent before applying each accepted row.

## Review before applying

Enable intake with the source fragment `form Operation import=csv`, optionally adding `review=readOperation`. The optional review is a pure read scenario returning a model-record array; its required named parameters must be a compatible subset of the target inputs/bindings. A configured review failure blocks the row. The review request identifies the operation and structural mapping. Parse the complete supplied input under configured size and row limits; report malformed rows and ambiguous headers. Convert cells using the operation’s canonical types and validations. Show a preview with field names, normalized values and row-specific errors before asking the user to confirm.

Confirmation is explicit and scoped to the reviewed preview. Only valid selected rows are eligible. Recheck current permission and invariants for every row when applying it. Each row commits independently through the canonical operation; a failure on one row does not roll back prior successful rows or silently authorize later rows. Return per-row outcomes and a resumable recovery path without exposing protected values.

Do not treat CSV as bulk database access. Import never bypasses policy, form constraints, versions or business rules. See [forms](03-forms-and-inputs.md), [transactions](../05-Workflows/03-transactions-and-concurrency.md), and [fixture examples](../09-Development/04-fixtures-and-examples.md).

```doc-visual
{
  "placeholder": "Use the CSV review to compare valid rows, errors and duplicates before committing selected rows.",
  "caption": "A synthetic CSV review before submission: marker 1 identifies the Valid, Invalid and Duplicate row statuses and details; marker 2 identifies Commit selected rows.",
  "alt": "CSV review with selectable valid rows, an invalid row, a duplicate row and the commit control",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Use an approved documentation app with a declared CSV-enabled operation and a synthetic signed-in account authorized to invoke it in the selected team. Open that operation’s canonical form and its CSV intake through the actual rendered control; do not invent an operation name or route.",
      "Prepare a small UTF-8 CSV with headers matching this operation’s real input paths: one valid synthetic row, an exact repeat of it, and a row violating a declared field constraint. Use harmless labels such as Sample A and Sample B and no personal data. Review the input, then stop before Commit selected rows; do not execute business mutations for the capture.",
      "Capture the actual CSV review heading, counts, row statuses, normalized inputs, field error, duplicate-row reference, valid-row selection and commit control. Keep any visible review/candidate summary; do not expose hidden consent tokens or operation identities through overlays or developer tools.",
      "Record the captured application and runtime revisions and capture date in the asset notes; do not include credentials, private addresses, session tokens or real personal data.",
      "Capture at 1280 by 800 with English interface text and the light theme. Use a focused crop so essential labels remain readable at narrow article widths."
    ],
    "edits": [
      "Crop unrelated browser and application content while retaining the review heading, counts, all three sample rows, their Detail cells and the Commit selected rows control.",
      "Add marker 1 beside the Status and Detail columns and marker 2 beside Commit selected rows. Preserve readable row labels, selection controls and actual error wording; explain both markers in the caption.",
      "Verify that only valid rows have selection controls and that the caption and alt text match the real capture."
    ]
  }
}
```

## Consent and row execution

Confirmation applies to a specific reviewed preview. Changed review candidates require renewed consent; each accepted row still passes the owning operation’s current checks and commits independently.

```mermaid
flowchart TD
  accTitle: CSV review and per-row consent
  accDescr: Typed preview and explicit selection precede confirmation. Each selected row reruns configured review; a review failure blocks that row, changed candidates return to confirmation, while unchanged review proceeds through current operation checks to an independent row outcome.
  preview[Typed row preview] --> consent[Select and confirm]
  consent --> review[Rerun configured review]
  review --> valid{Review succeeds?}
  valid -->|No| blocked[Block row]
  valid -->|Yes| changed{Candidates changed?}
  changed -->|Yes| preview
  changed -->|No| operation[Current operation checks]
  operation --> outcome[Independent row outcome]
```

A configured review failure blocks that row. Keep succeeded, failed, pending and unknown outcomes distinct when recovering.

## Pinned CSV profile

Input is UTF-8, optionally beginning with a BOM, with a required header, comma separators, doubled quotes and CRLF or LF record boundaries; quoted newlines are preserved. There is no delimiter or locale guessing and no formula evaluation. One review accepts at most 10 MiB and 1,000 data rows. Input is transient intake data, not an attachable file or an upload-policy bypass.

Template headers use stable input paths. Unknown/duplicate headers and overlapping mappings must be corrected or excluded. Bound parent, record and identity inputs cannot be replaced by CSV. References and expected versions use authorized reference controls; a display label does not silently choose a record. Empty nullable cells become null; nonnullable text keeps empty text and then applies constraints. Omitted columns use ordinary defaults or report required-input errors. Integers/decimals use canonical decimal text, booleans `true`/`false`, enums stable case names, and dates/instants their canonical forms. Money and references use typed leaf columns such as `amount.minor`, `amount.currency`, `customer.id` and `customer.version`; arrays/structural values use closed typed JSON. File, secret and action cells cannot supply opaque authority: use protected bindings or ordinary authorized controls.

Exact repeated normalized rows are flagged. Candidate matches come from the optional review, with no automatic merge, upsert or role transfer. Confirmation submits selected rows in source order, retaining one operation identity and frozen inputs per row. Report succeeded, failed, pending and unknown separately. Retry retains that identity; changing a successful row requires a new reviewed invocation. Before each submission, rerun the configured review: changed candidates require renewed confirmation, while unchanged matches still require the recorded explicit create decision. Review does not lock out concurrent duplicates; owning guards and uniqueness rules remain authoritative.

Draft review state is private to the authenticated user/app/team and expires after 24 hours. Logout or context loss immediately revokes access. Recover only authorized drafts; receipt retention follows its independent replay contract.
