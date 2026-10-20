# Collections and views

Collections present authorized query results; reusable views compose authorized values into readable output. A collection is not an alternate data-access policy.

## Collections

A `list`, `table`, `board`, `gallery` or agenda `calendar` consumes a typed query. The owning declaration defines row scope, permitted filters, ordering and projection. Pagination carries that collection state; it does not widen it. Empty and no-match states are distinct from errors. Details and history require the same current read grants as the parent page.

CSV export and print operate on the complete authorized result within declared limits, not merely the currently visible page. Protected media URLs are resolved under current file access. See [export and print](09-export-and-print.md), [file lifecycle](../07-Integrations/03-files-and-attachments.md), and [collection components](../12-Reference/13-components-collections-and-media.md).

## Reusable presentation

Ordinary `view Name(row: Model)` and `show Name {row=expression}` compose checked presentation without AI generation. The row is one nonnullable stored-model value, evaluated once; do not assume arbitrary props, nested `show`, caller capture or cross-package export. A view uses only fields admitted by the authorized projection. A collection renderer must preserve each row’s context and canonical action bindings. Generated custom views are a separate extension; see [styles and custom views](../08-Code-generation/03-styles-and-custom-views.md).
