# Forms and inputs

Forms derive their schema and permissions from the operation or record they bind. Inputs collect typed values; the server validates and authorizes every submission again.

## Bind to an owner

A form binds a canonical operation, or `edit` binds the update operation for a record. The inferred arguments determine writable fields, types, defaults and required values. Explicit field selection can omit only already bound, defaulted or optional inputs; required unbound inputs must remain present. It cannot add authority or write protected fields. `primary` supplies the owning submit action; other checked actions remain distinct.

Use `select` for a reference only when the caller can currently read the selectable records and fields. File inputs use the upload/finalize/attach lifecycle; a browser-supplied URL is not a file reference. Validation messages belong beside their control, with the shared validation outlet available where the form places it.

## Submission outcomes

A valid form can still be refused because permission, membership, row version, invariant or lock state changed after rendering. Preserve editable input and explain a conflict so the user can review and submit again. Do not retry a non-idempotent operation invisibly. See [CRUD](../05-Workflows/01-crud-and-record-lifecycle.md), [actions](../05-Workflows/08-actions-and-invocations.md), and [input reference](../12-Reference/11-components-inputs.md).
