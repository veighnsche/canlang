# Export and print

Export the complete authorized task collection, print a declared report or record view, and verify filtering, pagination, field access and failures before sharing the resulting copy.

## CSV export

An export is built from the declared collection and currently readable projection, including its accepted filters and ordering. It is not limited to the visible pagination window. Values use canonical CSV escaping and exact typed serialization; formula-like text must not become executable spreadsheet content. Reject or report limit overflow rather than returning a misleading partial file. Generated `Model.export` and `readScenario.export` retain typed filters and declared result schemas; include safe identity/version and currency/unit columns where applicable. Large exports are persisted jobs with authorized expiring downloads and shared runtime limits/status.

## Print

Print composes the declared printable page, collection and detail content, not only what happens to be visible in the browser viewport. Apply the same authorization and field projection, and omit interactive controls while retaining readable labels and totals. Protected file links remain protected. Downloads should be short-lived and scoped to the current authorized request.

Use the shared collection Export and detail/read-result Print controls. These are generated controls, not authored `export` or `print` keywords. Inactive tabs and undeclared related data are not inferred; expose every required section through the actual printable composition. A failed, unavailable or partial read cannot produce a complete-looking report. Printing creates no stored document; native browser printing may save the presentation as PDF. See [collections](03-collections-and-views.md) and [field access](../05-Permissions-and-policy/02-read-policies-and-field-access.md).

## Export the Tasks collection

Use the complete [InterfaceTasks.can](../examples/interface-tasks/InterfaceTasks.can) app and the [CSV exercise](07-csv-import.md). No authored `export` statement is necessary: the following `Then` composition declares the collection that supplies the shared Export control.

```can
table Todo columns=title,done,evidence order=title
 pagination
```

1. Create several tasks with distinguishable titles, then mark one done through its authorized edit action.
2. On **Import and review tasks**, apply the available collection filters and ordering you want to export. Choose the shared **Export** control.
3. Inspect the downloaded CSV header and rows. The result covers the complete eligible collection within limits, not just the visible page. If the table spans pages, compare the export count with the full matching set.
4. Check that only readable fields are included, booleans have their typed representation, and quoted/comma-containing titles round-trip through CSV escaping. Exported file references do not turn protected attachments into public downloads.

For a durable business filter, use the app's pure read operation instead of relying on a temporary screen selection:

```can
scenario open_tasks() read=true -> Todo[] by=members
 do return (Todo as task where not task.done order=task.title)
```

The `/open` page presents `form open_tasks`. Run it, inspect the read result and use its generated export control. Completed tasks must be absent. The derived `InterfaceTasks.open_tasks.export` retains that declared result scope; it does not mean “export every Todo”. For direct calls, discover its actual generated schema rather than inventing filter arguments.

## Print a result you have inspected

On **Open task report**, run the read form, then choose the shared read-result **Print** control. Review the print presentation before opening the browser's print dialog. Verify that the report contains the eligible tasks, readable labels and the declared content beyond the current viewport, with editing controls omitted. Browser “Save as PDF” creates a local copy; Can does not create a stored document merely because Print was used.

For a single record, open its generated detail view and use its shared Print control. This prints that declared detail composition, not an inferred graph of related records or inactive tabs. If you need a related collection in a report, include it explicitly in the printable source composition and grant its reads.

## Check failures and downloaded copies

A limit failure or unavailable read must be visible rather than producing a complete-looking partial report. Large exports use persisted jobs; follow their status and obtain the authorized expiring download when ready. Do not repeatedly start a new job because the first has not finished.

Repeat the operation after removing the user's relevant grant: current authorization must refuse or narrow the result. Previously downloaded CSV/PDF bytes remain with their recipient; revoking access cannot erase a local copy. Protected file links still require their own current download authority.
