# Collections and media

Collection and media components consume authorized rows, cursors and finalized media references from their owning context.

## Source forms

The forms below are header patterns: square brackets mean optional syntax, `|` lists alternatives, and words such as `selector`, `value` and `caption` are placeholders. They are source fragments requiring the stated owner, not complete applications. Content suites use ordinary indented Can; named slots use `slot name` with a nonempty indented suite. Slots cannot mix with regular direct children.

Appearance options are optional and limited to the per-entry values below. No raw classes, arbitrary properties or event handlers are accepted. Input captions derive from their fields. A selector has at most one writable control, and unmentioned eligible inputs still render in owning schema order. A collection/result scope ends field placement unless it contains a new explicit field owner.

### `avatar`

Header: `avatar image [caption=text] [fallback=text]`. Leaf. The image must be authorized; caption and fallback are safe text.

Appearance: `variant=solid`.

### `carousel`

Header: `carousel [sequence]`. Requires item slots. With a query or typed readable sequence, exactly one slot item template renders for each admitted row; without an operand, repeated authored slot item suites are explicit items. Scope, field grants and stable ordering remain checked.

Slots: `slot item` (required, repeatable).

Appearance: `variant=solid`, `orientation=horizontal|vertical`.

### `hover_gallery`

Header: `hover_gallery [sequence]`. Requires item slots. With a query or typed readable sequence, exactly one slot item template renders for each admitted row; without an operand, repeated authored slot item suites are explicit items. Scope, field grants and stable ordering remain checked. At most ten authorized images; keyboard/touch alternatives remain available.

Slots: `slot item` (required, repeatable).

### `list`

Header: `list query [columns=fields]`. Collection leaf using default row presentation, or a nonempty row presentation suite. Optional order, search, filter, empty, defaults and display=split retain the canonical collection semantics.

### `pagination`

Header: `pagination`. Leaf only within a collection; it uses that collection’s cursor, filter and ordering state.

### `table`

Header: `table query columns=fields`. Collection leaf using default row presentation, or a nonempty row presentation suite. columns= is required. Optional order, search, filter, empty, defaults and display=split retain the canonical collection semantics.

Appearance: `size=xs|sm|md|lg|xl`, `variant=solid`.
