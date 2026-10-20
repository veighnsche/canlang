# Forms and inputs

Forms derive their schema and permissions from the operation or record they bind. Inputs collect typed values; the server validates and authorizes every submission again.

## Bind to an owner

A form binds a canonical operation, or `edit` binds the update operation for a record. The inferred arguments determine writable fields, types, defaults and required values. Explicit field selection can omit only already bound, defaulted or optional inputs; required unbound inputs must remain present. It cannot add authority or write protected fields. `primary` supplies the owning submit action; other checked actions remain distinct.

Use `select` for a reference only when the caller can currently read the selectable records and fields. File inputs use the upload/finalize/attach lifecycle; a browser-supplied URL is not a file reference. Validation messages belong beside their control, with the shared validation outlet available where the form places it.

## Submission outcomes

A valid form can still be refused because permission, membership, row version, invariant or lock state changed after rendering. Preserve editable input and explain a conflict so the user can review and submit again. Do not retry a non-idempotent operation invisibly. See [CRUD](../05-Workflows/01-crud-and-record-lifecycle.md), [actions](../05-Workflows/08-actions-and-invocations.md), and [input reference](../12-Reference/11-components-inputs.md).

```doc-visual
{
  "placeholder": "Compare your preserved form input with current values when a submission reports a conflict.",
  "caption": "A sample record edit after a version conflict: marker 1 identifies preserved editable input; marker 2 identifies the conflict message and authorized current values.",
  "alt": "Record edit form with preserved input and a conflict message comparing current field values",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Use an approved documentation app with an existing editable sample record and a documentation account authorized to read and update it. Open its declared record page and canonical edit form; obtain the actual address from the operator rather than inventing a route.",
      "Use synthetic text only: begin editing a text field to Draft note in one browser session, update that same sample record to Current note in a second authorized session, then submit the first edit to produce a real version conflict. Retain its editable input, the conflict message, current-value table and submit control in the capture. Do not add a visible version field when the actual form carries it only as hidden metadata.",
      "Record the captured application and runtime revisions and capture date in the asset notes; do not include credentials, private addresses, session tokens or real personal data.",
      "Capture at 1280 by 800 with English interface text and the light theme. Use a focused crop so essential labels remain readable at narrow article widths."
    ],
    "edits": [
      "Crop browser chrome, account details and unrelated records while keeping the form heading, edited field, conflict message, current-value table and submit control visible.",
      "Add marker 1 beside the preserved editable field and marker 2 beside the conflict message and current-value table. Do not cover labels or change interface text; these are the only numbered annotations.",
      "Use the caption to explain markers 1 and 2, and verify the alt text against the final capture."
    ]
  }
}
```
