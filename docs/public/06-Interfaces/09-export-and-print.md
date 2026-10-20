# Export and print

Exports and print views use the same authorized query scope as the page and cover the complete eligible result within explicit limits.

## CSV export

An export is built from the declared collection and currently readable projection, including its accepted filters and ordering. It is not limited to the visible pagination window. Values use canonical CSV escaping and exact typed serialization; formula-like text must not become executable spreadsheet content. Reject or report limit overflow rather than returning a misleading partial file. Generated `Model.export` and `readScenario.export` retain typed filters and declared result schemas; include safe identity/version and currency/unit columns where applicable. Large exports are persisted jobs with authorized expiring downloads and shared runtime limits/status.

## Print

Print composes the declared printable page, collection and detail content, not only what happens to be visible in the browser viewport. Apply the same authorization and field projection, and omit interactive controls while retaining readable labels and totals. Protected file links remain protected. Downloads should be short-lived and scoped to the current authorized request.

Use the shared collection Export and detail/read-result Print controls. These are generated controls, not authored `export` or `print` keywords. Inactive tabs and undeclared related data are not inferred; expose every required section through the actual printable composition. A failed, unavailable or partial read cannot produce a complete-looking report. Printing creates no stored document; native browser printing may save the presentation as PDF. See [collections](02-collections-and-views.md) and [field access](../04-Access-and-rules/03-read-policies-and-field-access.md).
