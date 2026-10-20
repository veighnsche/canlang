# Browse task collections and reuse ordinary views

Present the same authorized tasks as lists, tables, boards and agendas, and uploaded images as a gallery. Add search, filters, ordering and pagination while preserving nested row scope and reusable views.

## Use the complete TaskPages app

Start with the complete [TaskPages source and setup](01-pages-and-navigation.md#start-with-the-complete-taskpages-app). Every code block below is an excerpt from its `Then` section, not a standalone application. Keep its `Given` models, read policies, CRUD and invariant.

Create tasks with different titles, statuses and start times. A task's end cannot precede its start. Create steps from each task's detail page. For the gallery, upload a small public-safe image through the Photos form; do not paste an external image URL into the `file` field.

## Choose a collection for the question

| Presentation | TaskPages example | What readers can see |
| --- | --- | --- |
| `list Todo` | `/` | A task summary and its canonical actions |
| `table Todo columns=...` | `/table` | Comparable fields with adjacent selected-record detail |
| `board Todo by=status` | `/board` | Cards grouped by a declared enum field |
| `calendar Todo start=starts end=ends` | `/agenda` | A date-grouped agenda in the team timezone |
| `gallery Photo image=image` | `/photos` | Authorized image thumbnails and keyboard preview |

All five consume typed, authorized data. Presentation never widens a query or creates a new policy. Empty data, no search matches, loading and read failure are distinct states; a failed read must not masquerade as an empty successful result.

## Search, filter and order a list

```can
list Todo as task search=title filter=status order=-created empty="No tasks match."
 show TaskSummary {row=task}
 link target=app_url(format("/tasks/{id}",{id=task.id})) caption="Open task"
 edit
 pagination
```

`search=title` declares the searchable field. `filter=status` declares a typed filter control. These are selector lists, not arbitrary query expressions or new permissions. Add an authored `where` query when the collection itself should always select a subset; a user clearing a toolbar filter does not remove that authored predicate.

`order=-created` sorts newest first. A plain selector such as `order=starts` is ascending; comma-separated selectors provide successive keys. Equal stored-record values use the stable record-ID tie-breaker. Null sorts after nonnull in either direction; typed arrays retain their original element order for ties. Sorting cannot expose a withheld field.

Filters accept only operations suitable for the selected field's type. Active fields combine with AND, with at most one condition per selector. No condition means unrestricted; `is_null` is distinct from an empty control. Nonnull comparisons do not match null rows, even for inequality, and withheld data is never treated as null.

A collection can initialize declared controls through `defaults={field=value}`, including a compatible owned preference. Explicit URL/current control state wins. Clearing a filter keeps it cleared; the default does not immediately reapply. Defaults are initial presentation state, not a security restriction.

## Paginate the same admitted query

`pagination` belongs inside its collection. It consumes that collection's authorized cursor, search, filters and order; it is not an independent page-number store. Changing query/order/preferences restarts pagination and invalidates the old order-bound cursor while retaining still-valid filters and authorized unsaved inputs.

Navigate forward and back after applying a filter: every page must retain that filter. Do not add a pagination control outside the collection or interpret one page of results as the entire dataset. [CSV export and print](08-export-and-print.md) use complete authorized results within their declared bounds, rather than just the visible page.

## Compare records and open split details

```can
table Todo columns=title,status,starts,ends search=title filter=status order=starts display=split
 show TaskSummary {row=row}
 edit
 pagination
```

A table requires explicit columns. `display=split` on a list or table gives the selected authorized row one adjacent detail pane; on mobile that detail uses a drawer. With no selection or no longer-readable selection, the pane is empty. It must not guess another record or preserve stale private detail.

The selected row and its canonical edit bindings remain in scope. Selection does not mutate a task. An activated `details display=drawer` is a separate presentation option: it opens only the activated record, not every repeated row. `open=` belongs to ordinary Collapse details and cannot accompany drawer display.

```doc-visual
{
  "placeholder": "Select a task in the table to see its adjacent detail pane and edit control.",
  "caption": "TaskPages with a selected task and its matching detail pane; numbered markers identify the selected row and its detail.",
  "alt": "Task table with one selected task and the same task shown in an adjacent detail pane",
  "production": {
    "method": "screenshot",
    "instructions": [
      "Run the complete docs/public/examples/task-pages/TaskPages.can application on a documentation preview with a signed-in team member. Record the product revision and capture date.",
      "Create synthetic tasks Release checklist and Review wording with different statuses and valid start/end dates. Open /table and select Release checklist.",
      "Capture at 1280 by 800 in the light theme. Preserve the table headings, selected row, detail title and edit control; use no personal records or credentials."
    ],
    "edits": [
      "Crop unrelated browser chrome while keeping the table and detail pane together.",
      "Add numbered rectangles 1 around the selected row and 2 around its detail title without covering labels. Explain both markers in the final caption.",
      "Verify labels remain readable and the image, caption and alt text match the actual captured interface."
    ]
  }
}
```

## Group a board and read an agenda

```can
board Todo by=status columns=title,starts order=starts
 show TaskSummary {row=row}
 edit
 pagination
```

`by=status` chooses one enum field. Use the normal edit operation to change status; the board does not imply drag-and-drop or a state-machine transition. Canonical guards, field permissions and managed-state restrictions still apply.

```can
calendar Todo start=starts end=ends columns=title,status order=starts
 text row.title,row.status
 edit
 pagination
```

Both endpoint selectors are required. This is an agenda in the team timezone, not a drag/resize scheduling engine. The sample's invariant owns the start/end relationship. Calendar display does not create recurrence or schedule asynchronous work; see [dates and timezones](../04-Model-and-query-data/05-dates-and-timezones.md) and [scheduling](../06-Business-workflows/07-scheduling-and-recurring-work.md).

## Review authorized images

```can
gallery Photo image=image columns=title search=title order=-created
 text row.title
 edit
 pagination
```

The required image selector names a readable `file` field containing an allowed image. The gallery preserves ordinary query and row scope while supplying responsive thumbnails, keyboard preview and authorized original access. Opening or previewing rechecks row, field and attachment access; a cached thumbnail URL is not a permission grant.

Use the actual file upload flow and its validation errors. Unsupported images or failed authorization are not blank successful images. See [file lifecycle](../08-Connect-services/03-files-and-attachments.md) for finalization and attachment rules.

## Keep outer aliases when row changes

```can
list Todo as task order=title
 text task.title
 list Step as step columns=title,done
  text task.title,step.title,step.done
  edit
 pagination
```

The outer collection binds `row:Todo` and alias `task`. Inside the nested collection, `row` becomes the current `Step`, while `task` still names its enclosing task and `step` names the current child. The nested `edit` edits the step, not the task.

Because `Step in Todo` declares containment, this direct-child collection scopes to the enclosing task automatically. An unrelated model-reference relationship needs an explicit `where` condition; matching a field name or placing a collection underneath another is not containment.

The same enclosing record chain supports form binding. On the task detail page, `form Step.create` has exactly one compatible task parent. If several compatible records are available, use explicit `arguments={parameter=expression}` instead of relying on ambiguous auto-binding. A bare field selector resolves against the current row schema.

## Reuse presentation with ordinary view and show

```can
view TaskSummary(row:Todo)
 card "Task"
  text row.title,row.status,row.starts,row.ends
```

This definition belongs directly in `Then`. `show TaskSummary {row=task}` passes a readable task from the list; `show TaskSummary {row=row}` passes the current task from a record page, board or table. The argument is evaluated once.

An ordinary view has a nonempty presentation body and exactly one required, nonnullable local stored-model `row`. It resolves names in its own module and cannot capture caller aliases such as `task`. Pass the record explicitly. It cannot be exported, take arbitrary props/slots or nest another `show` at any depth. Its body remains subject to current field access and preserves the record context for canonical controls.

A view-level `require` gates the whole instance; a guard inside its card gates only that card. No guard grants fields or operation authority. The sample uses ordinary checked presentation with no generation prompt or AI step. [Generated views and styles](../03-Generate-implementation/03-styles-and-custom-views.md) are a separate extension.

## Verify collection behavior

1. Create two tasks with distinct titles, statuses and dates. Search for one title, filter by status, then clear both controls. Confirm each state shows only its matching authorized records.
2. Add enough records to advance pagination. Change order/filter state and confirm the collection restarts rather than applying an incompatible old cursor.
3. Open `/table`, select each task and edit it. Confirm the detail and mutation refer to the selected task. Check the mobile drawer and its return focus.
4. Edit a task's status, then open `/board`. Confirm the card belongs to that enum group. Check its dates on `/agenda` in the team timezone.
5. Add different steps under the two task details. On `/steps`, confirm each outer task displays only its own children, and editing a child leaves the other task's steps unchanged.
6. Upload an authorized image and open `/photos`. Verify thumbnail, keyboard preview and original access. Withdraw access and confirm reopening does not reuse an earlier grant.

The same `TaskSummary` should show the same admitted fields wherever the same record is presented. Differences in presentation must not create different business permissions. For component-specific options, use the [collection reference](../14-Component-reference/05-components-collections-and-media.md).
