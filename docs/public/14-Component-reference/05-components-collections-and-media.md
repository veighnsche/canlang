# Collections and media

Present authorized tasks and finalized images through collections and media components. These examples connect row scope, item slots, selection and pagination without widening read or file access.

## Example context

The examples are alternative page-body fragments for the complete [ComponentTasks scaffold](../07-Build-interfaces/02-components-and-layout.md#start-with-a-complete-component-scaffold). Replace that scaffold’s root page body with one fragment at a time; nested forms and collections supply their own scope. Do not paste all alternatives into one form.

## Source forms

The forms below are header patterns: square brackets mean optional syntax, `|` lists alternatives, and words such as `selector`, `value` and `caption` are placeholders. They are source fragments requiring the stated owner, not complete applications. Content suites use ordinary indented Can; named slots use `slot name` with a nonempty indented suite. Slots cannot mix with regular direct children.

Appearance options are optional and limited to the per-entry values below. No raw classes, arbitrary properties or event handlers are accepted. Input captions derive from their fields. A selector has at most one writable control, and unmentioned eligible inputs still render in owning schema order. A collection/result scope ends field placement unless it contains a new explicit field owner.

### `avatar`

Header: `avatar image [caption=text] [fallback=text]`. Leaf. The image must be authorized; caption and fallback are safe text.

Appearance: `variant=solid`.

```can
list Photo
 avatar row.image caption=row.title fallback="Photo unavailable"
```

Each image is an authorized finalized file. Fallback text never reveals withheld file details.

### `carousel`

Header: `carousel [sequence]`. Requires item slots. With a query or typed readable sequence, exactly one slot item template renders for each admitted row; without an operand, repeated authored slot item suites are explicit items. Scope, field grants and stable ordering remain checked.

Slots: `slot item` (required, repeatable).

Appearance: `variant=solid`, `orientation=horizontal|vertical`.

```can
carousel Photo
 slot item
  avatar row.image caption=row.title
```

One item template renders each admitted image row. Respect the gallery’s bounded item count and keyboard/touch access; original files retain authorization.

### `hover_gallery`

Header: `hover_gallery [sequence]`. Requires item slots. With a query or typed readable sequence, exactly one slot item template renders for each admitted row; without an operand, repeated authored slot item suites are explicit items. Scope, field grants and stable ordering remain checked. At most ten authorized images; keyboard/touch alternatives remain available.

Slots: `slot item` (required, repeatable).

```can
hover_gallery Photo
 slot item
  avatar row.image caption=row.title
```

One item template renders each admitted image row. Respect the gallery’s bounded item count and keyboard/touch access; original files retain authorization.

### `list`

Header: `list query [columns=fields]`. Collection leaf using default row presentation, or a nonempty row presentation suite. Optional order, search, filter, empty, defaults and display=split retain the canonical collection semantics.

```can
list Todo as task columns=title,done search=title filter=priority order=-created
 edit
 pagination
```

Search/filter/order and pagination remain bound to the same authorized query; edit uses the current task.

### `pagination`

Header: `pagination`. Leaf only within a collection; it uses that collection’s cursor, filter and ordering state.

```can
list Todo columns=title,done order=-created
 pagination
```

The control is inside its collection and retains that collection’s filter, order and cursor state.

### `table`

Header: `table query columns=fields`. Collection leaf using default row presentation, or a nonempty row presentation suite. columns= is required. Optional order, search, filter, empty, defaults and display=split retain the canonical collection semantics.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.

```can
table Todo columns=title,priority,done size=sm display=split
 text row.note
 edit
 pagination
```

The selected readable task owns the split detail and edit control; unselected records do not open panels.
